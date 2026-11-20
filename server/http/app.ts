import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { bus, type BusEvent } from '../bus.ts';
import type { AppConfig } from '../config.ts';
import { logger } from '../log.ts';
import type { Notifier } from '../notify/index.ts';
import type { Engine } from '../po/engine.ts';
import type { PoAgent } from '../po/agent.ts';
import { diffText, inspectRepo } from '../projects/git.ts';
import type { Search } from '../search/index.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY, type Store } from '../store.ts';
import type { Orchestrator } from '../teams/orchestrator.ts';
import type { Priority, StateSnapshot, TemplateRole } from '../../shared/types.ts';

const log = logger('http');
const VERSION = '0.1.0';

export interface AppDeps { cfg: AppConfig; store: Store; orch: Orchestrator; engine: Engine; po: PoAgent; search: Search; notifier: Notifier }
type Env = { Bindings: HttpBindings; Variables: { access: 'local' | 'remote'; login: string | null } };

const roleZ = z.object({ key: z.string().min(1).max(20).regex(/^[a-z0-9_-]+$/), name: z.string().min(1).max(20), model: z.enum(['opus', 'sonnet', 'haiku']), mode: z.enum(['session', 'subagent']), tools: z.enum(['pm', 'write', 'verify', 'read']), prompt: z.string().max(4000).optional() });
const priorityZ = z.enum(['urgent', 'normal', 'low']);

class HttpError extends Error { constructor(public status: 400 | 403 | 404 | 409, msg: string) { super(msg); } }

export function createApp(d: AppDeps): Hono<Env> {
  const { store, orch, engine, po, search, cfg, notifier } = d;
  const app = new Hono<Env>();

  /* ---------- 접속 확인 ---------- */
  app.use('/api/*', async (c, next) => {
    const login = c.req.header('tailscale-user-login') ?? null;
    const addr = c.env?.incoming?.socket?.remoteAddress ?? '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
    if (login) {
      const owner = store.getSettings().ownerLogin;
      store.setKv('last_remote_login', { login, at: new Date().toISOString() });
      if (!owner) return c.json({ error: `원격 접속 주인이 아직 등록되지 않았습니다. 맥에서 설정 › 원격 접속에서 ${login} 을(를) 주인으로 등록하세요.` }, 403);
      if (owner.toLowerCase() !== login.toLowerCase()) return c.json({ error: `허용되지 않은 계정입니다: ${login}` }, 403);
      c.set('access', 'remote');
    } else if (loopback) c.set('access', 'local');
    else return c.json({ error: '로컬 또는 Tailscale 로만 접속할 수 있습니다' }, 403);
    c.set('login', login);
    await next();
  });
  const localOnly = (c: Context<Env>) => { if (c.get('access') !== 'local') throw new HttpError(403, '이 작업은 맥에서만 할 수 있습니다(원격은 보기만)'); };

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    if (e instanceof z.ZodError) return c.json({ error: '입력값이 올바르지 않습니다', detail: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    log.error(`${c.req.method} ${c.req.path}`, e);
    return c.json({ error: e instanceof Error ? e.message : '서버 오류' }, 500);
  });
  const body = async <T extends z.ZodTypeAny>(c: Context<Env>, schema: T): Promise<z.infer<T>> => schema.parse(await c.req.json().catch(() => ({})));
  const team = (id: string) => { const t = store.getTeam(id); if (!t) throw new HttpError(404, '팀이 없습니다'); return t; };

  /* ---------- 상태·스트림 ---------- */
  app.get('/api/state', (c) => {
    const snap: StateSnapshot = {
      version: VERSION, access: c.get('access'), settings: store.getSettings(), resource: engine.last, projects: store.listProjects(), templates: store.listTemplates(),
      teams: store.listTeams().map((t) => store.teamView(t)), proposals: store.listProposals('pending'), poBusy: po.busy, vapidPublicKey: notifier.vapidPublicKey(),
    };
    return c.json(snap);
  });
  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    const queue: BusEvent[] = [];
    let wake: (() => void) | null = null;
    const off = bus.onEvent((e) => { queue.push(e); wake?.(); });
    stream.onAbort(() => { off(); wake?.(); });
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ version: VERSION }) });
    let lastState = 0;
    while (!stream.aborted) {
      if (!queue.length) await Promise.race([new Promise<void>((r) => { wake = r; }), stream.sleep(15000)]);
      wake = null;
      if (stream.aborted) break;
      if (!queue.length) { await stream.writeSSE({ event: 'ping', data: '' }); continue; }
      const batch = queue.splice(0);
      let sawState = false;
      for (const e of batch) {
        if (e.type === 'state') { sawState = true; continue; }
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
      if (sawState && Date.now() - lastState > 300) { lastState = Date.now(); await stream.writeSSE({ event: 'state', data: '{}' }); }
      else if (sawState) setTimeout(() => bus.changed('debounce'), 350);
    }
    off();
  }));

  app.get('/api/teams/:id', (c) => { const dt = store.teamDetail(c.req.param('id')); if (!dt) throw new HttpError(404, '팀이 없습니다'); return c.json(dt); });
  app.get('/api/agents/:id', (c) => { const dt = store.agentDetail(c.req.param('id')); if (!dt) throw new HttpError(404, '에이전트가 없습니다'); return c.json(dt); });
  app.get('/api/teams/:id/diff', async (c) => {
    const t = team(c.req.param('id'));
    if (!t.worktree_path || !t.base_sha) return c.json({ diff: '' });
    return c.json({ diff: await diffText(t.worktree_path, t.base_sha, c.req.query('path') || undefined) });
  });

  /* ---------- PO 대화 ---------- */
  app.get('/api/chat', (c) => c.json(store.chat(Number(c.req.query('limit') ?? 200), c.req.query('before') ? Number(c.req.query('before')) : undefined)));
  app.post('/api/chat', async (c) => { const b = await body(c, z.object({ text: z.string().min(1).max(8000) })); po.say(b.text); return c.json({ ok: true }); });

  app.post('/api/proposals/:id/approve', async (c) => {
    const b = await body(c, z.object({ roles: z.array(roleZ).optional(), priority: priorityZ.optional(), project_id: z.string().nullable().optional(), budget_usd: z.number().positive().nullable().optional(), confirm: z.boolean().optional() }));
    if (c.get('access') === 'remote' && !b.confirm) throw new HttpError(409, '원격에서는 한 번 더 확인이 필요합니다');
    const t = orch.createFromProposal(c.req.param('id'), { roles: b.roles as TemplateRole[] | undefined, priority: b.priority, project_id: b.project_id, budget_usd: b.budget_usd });
    return c.json({ team: store.teamView(t) });
  });
  app.post('/api/proposals/:id/reject', (c) => { store.updateProposal(c.req.param('id'), { status: 'rejected' }); store.addChat({ role: 'event', body: '제안을 거절했습니다' }); return c.json({ ok: true }); });

  /* ---------- 팀 조작 ---------- */
  app.post('/api/teams/:id/pause', async (c) => { team(c.req.param('id')); await orch.pause(c.req.param('id'), 'user', '사용자가 멈춤'); return c.json({ ok: true }); });
  app.post('/api/teams/:id/resume', async (c) => { team(c.req.param('id')); await orch.resume(c.req.param('id'), 'user', '사용자가 재개'); return c.json({ ok: true }); });
  app.post('/api/teams/:id/pin', async (c) => { const b = await body(c, z.object({ on: z.boolean() })); team(c.req.param('id')); orch.pin(c.req.param('id'), b.on); return c.json({ ok: true }); });
  app.post('/api/teams/:id/priority', async (c) => { const b = await body(c, z.object({ priority: priorityZ })); team(c.req.param('id')); orch.setPriority(c.req.param('id'), b.priority as Priority); return c.json({ ok: true }); });
  app.post('/api/teams/:id/answer', async (c) => { const b = await body(c, z.object({ text: z.string().min(1).max(8000) })); team(c.req.param('id')); orch.answer(c.req.param('id'), b.text); return c.json({ ok: true }); });
  app.post('/api/teams/:id/message', async (c) => { const b = await body(c, z.object({ text: z.string().min(1).max(8000) })); team(c.req.param('id')); return c.json({ result: orch.message(c.req.param('id'), b.text) }); });
  app.post('/api/teams/:id/cancel', async (c) => { team(c.req.param('id')); await orch.cancel(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/teams/:id/archive', async (c) => { localOnly(c); team(c.req.param('id')); await orch.archive(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/teams/:id/retry', async (c) => {
    const t = team(c.req.param('id'));
    if (t.state !== 'failed') throw new HttpError(409, '실패한 팀만 다시 시작할 수 있습니다');
    store.updateTeam(t.id, { state: 'queued', error: null, finished_at: null, nudges: 0 });
    store.addDecision(t.id, 'user', 'retry', '다시 시작');
    return c.json({ ok: true });
  });

  /* ---------- 직속 팀 ---------- */
  const standingZ = z.object({
    name: z.string().min(1).max(60), project_id: z.string().nullable().default(null), template_id: z.string().nullable().default('tpl-ops'), roles: z.array(roleZ).optional(),
    brief: z.string().max(8000).default(''), check_command: z.string().max(2000).nullable().optional(), check_interval_sec: z.number().int().min(30).max(86400).nullable().optional(),
    readable_team_ids: z.array(z.string()).optional(),
  });
  app.post('/api/standing', async (c) => { localOnly(c); const b = await body(c, standingZ); const t = orch.createStanding({ ...b, roles: b.roles as TemplateRole[] | undefined }); return c.json({ team: store.teamView(t) }); });
  app.patch('/api/standing/:id', async (c) => { localOnly(c); const b = await body(c, standingZ.partial().omit({ project_id: true, template_id: true, roles: true })); orch.updateStanding(c.req.param('id'), b); return c.json({ ok: true }); });

  /* ---------- 프로젝트 ---------- */
  app.post('/api/projects/inspect', async (c) => { localOnly(c); const b = await body(c, z.object({ path: z.string().min(1) })); return c.json(await inspectRepo(b.path)); });
  const projectZ = z.object({
    path: z.string().min(1), name: z.string().min(1).max(60).optional(), base_ref: z.string().min(1).optional(), deps_strategy: z.enum(['symlink', 'install', 'none']).default('symlink'),
    heavy_patterns: z.array(z.string()).optional(), blocked_patterns: z.array(z.string()).optional(), memory_paths: z.array(z.string()).optional(), default_template_id: z.string().nullable().optional(),
  });
  app.post('/api/projects', async (c) => {
    localOnly(c);
    const b = await body(c, projectZ);
    const info = await inspectRepo(b.path);
    if (store.listProjects().some((p) => p.path === info.root)) throw new HttpError(409, '이미 등록된 경로입니다');
    const p = store.insertProject({
      name: b.name ?? info.name, path: info.root, base_ref: b.base_ref ?? info.baseRef, deps_strategy: b.deps_strategy, heavy_patterns: b.heavy_patterns ?? DEFAULT_HEAVY,
      blocked_patterns: b.blocked_patterns ?? DEFAULT_BLOCKED, memory_paths: b.memory_paths ?? info.memoryPaths, default_template_id: b.default_template_id ?? 'tpl-dev',
    });
    return c.json(p);
  });
  app.patch('/api/projects/:id', async (c) => { localOnly(c); const b = await body(c, projectZ.omit({ path: true }).partial()); const p = store.updateProject(c.req.param('id'), b); if (!p) throw new HttpError(404, '프로젝트가 없습니다'); return c.json(p); });
  app.delete('/api/projects/:id', (c) => { localOnly(c); if (!store.deleteProject(c.req.param('id'))) throw new HttpError(409, '진행 중인 팀이 있는 프로젝트는 지울 수 없습니다'); return c.json({ ok: true }); });

  /* ---------- 템플릿·설정 ---------- */
  app.put('/api/templates/:id', async (c) => {
    localOnly(c);
    const b = await body(c, z.object({ name: z.string().min(1).max(40), description: z.string().max(200).default(''), roles: z.array(roleZ).min(1).max(8) }));
    const roles = b.roles as TemplateRole[];
    if (!roles.some((r) => r.key === 'pm')) roles.unshift({ key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm' });
    const cur = store.getTemplate(c.req.param('id'));
    return c.json(store.upsertTemplate({ id: c.req.param('id'), name: b.name, description: b.description, roles, builtin: cur?.builtin ?? false }));
  });
  app.delete('/api/templates/:id', (c) => { localOnly(c); store.deleteTemplate(c.req.param('id')); return c.json({ ok: true }); });

  const settingsZ = z.object({
    engine: z.object({
      cap: z.number().int().min(1).max(20), slotsGreen: z.number().int().min(0).max(10), slotsYellow: z.number().int().min(0).max(10),
      cpuY: z.number().min(10).max(100), cpuR: z.number().min(10).max(100), memY: z.number().min(10).max(100), memR: z.number().min(10).max(100), memHard: z.number().min(10).max(100),
      sustainSec: z.number().int().min(5).max(600), resumeSec: z.number().int().min(10).max(3600), hardPauseSec: z.number().int().min(10).max(3600), pauseEverySec: z.number().int().min(5).max(3600),
      stallMin: z.number().int().min(1).max(600), beatSec: z.number().int().min(10).max(3600),
    }).partial(),
    autoApprove: z.boolean(), defaultBudgetUsd: z.number().positive().max(10000), poModel: z.enum(['opus', 'sonnet', 'haiku']), contextLimitTokens: z.number().int().min(20000).max(1_000_000),
    ownerLogin: z.string().max(200).nullable(), slackWebhook: z.string().url().nullable().or(z.literal('').transform(() => null)),
    embedding: z.object({ provider: z.enum(['off', 'ollama', 'voyage']), model: z.string().max(100), url: z.string().max(200) }).partial(),
  }).partial();
  app.put('/api/settings', async (c) => { localOnly(c); const b = await body(c, settingsZ); return c.json(store.saveSettings(b as Parameters<Store['saveSettings']>[0])); });
  app.get('/api/remote', (c) => c.json({ ownerLogin: store.getSettings().ownerLogin, lastRemote: store.getKv('last_remote_login', null) }));
  app.post('/api/search/reindex', async (c) => { localOnly(c); return c.json({ indexed: await search.reindexAll() }); });
  app.get('/api/search', async (c) => c.json(await search.search(c.req.query('q') ?? '', { projectId: c.req.query('project') || null })));

  /* ---------- 푸시 ---------- */
  app.post('/api/push/subscribe', async (c) => {
    const b = await body(c, z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), device: z.string().max(100).default('') }));
    store.addPushSub(b.endpoint, b.keys, b.device);
    return c.json({ ok: true });
  });
  app.post('/api/push/test', async (c) => { await notifier.send({ title: '알림 시험', body: '이 알림이 보이면 설정이 끝났습니다.', level: 'info' }); return c.json({ ok: true }); });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

  /* ---------- 화면 ---------- */
  if (existsSync(cfg.webDist)) {
    app.use('/*', serveStatic({ root: cfg.webDist, rewriteRequestPath: (p) => p }));
    const index = join(cfg.webDist, 'index.html');
    app.get('*', (c) => c.html(readFileSync(index, 'utf8')));
  } else {
    app.get('/', (c) => c.text('화면이 빌드되지 않았습니다. `npm run build` 후 다시 열거나, 개발 중이면 http://127.0.0.1:4311 을 여세요.'));
  }
  return app;
}
