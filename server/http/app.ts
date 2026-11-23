import { existsSync, readFileSync } from 'node:fs';
import { readUpload, saveUpload } from '../uploads.ts';
import type { PrWatcher } from '../projects/prs.ts';
import type { RepoWatcher } from '../projects/repos.ts';
import type { ScriptRunner } from '../scripts.ts';
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
import { ConflictError, type Orchestrator } from '../teams/orchestrator.ts';
import type { Priority, StateSnapshot, TemplateRole } from '../../shared/types.ts';

const log = logger('http');
const VERSION = '0.1.0';

export interface AppDeps { cfg: AppConfig; store: Store; orch: Orchestrator; engine: Engine; po: PoAgent; search: Search; notifier: Notifier; prs?: PrWatcher; repos?: RepoWatcher; scripts?: ScriptRunner }
type Env = { Bindings: HttpBindings; Variables: { access: 'local' | 'remote'; login: string | null } };

const roleZ = z.object({ key: z.string().min(1).max(20).regex(/^[a-z0-9_-]+$/), name: z.string().min(1).max(20), model: z.enum(['opus', 'sonnet', 'haiku']), mode: z.enum(['session', 'subagent']), tools: z.enum(['pm', 'write', 'verify', 'read']), prompt: z.string().max(4000).optional() });
const priorityZ = z.enum(['urgent', 'normal', 'low']);

class HttpError extends Error { constructor(public status: 400 | 403 | 404 | 409, msg: string) { super(msg); } }

const pushLog = logger('push');

export function createApp(d: AppDeps): Hono<Env> {
  const { store, orch, engine, po, search, cfg, notifier } = d;
  const app = new Hono<Env>();

  /* ---------- 접속 확인 ----------
   * - 어느 리스너로 들어왔는지로 로컬/원격을 정한다. tailscale serve 는 remotePort 로만 넘긴다.
   *   (serve 는 127.0.0.1 에서 프록시하고, 태그 기기 요청엔 신원 헤더가 없으므로 주소·헤더만으로는 로컬과 구분 못 한다)
   * - Host 허용 목록: DNS 리바인딩 차단.
   * - 변경 요청(POST/PUT/PATCH/DELETE): JSON + X-Hivelane 헤더 필수, Origin 이 있으면 허용 목록. → 다른 사이트의 CSRF 차단.
   */
  const LOCAL_HOSTS = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, '127.0.0.1:4311', 'localhost:4311']);
  const hostOk = (host: string, remote: boolean) => (remote ? /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d+)?$/i.test(host) : LOCAL_HOSTS.has(host.toLowerCase()));
  app.use('/api/*', async (c, next) => {
    const localPort = c.env?.incoming?.socket?.localPort;
    const remote = localPort === cfg.remotePort;
    const host = c.req.header('host') ?? '';
    if (c.env?.incoming && !hostOk(host, remote)) return c.json({ error: `허용되지 않은 Host: ${host}` }, 403);
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json') || c.req.header('x-hivelane') !== '1') {
        return c.json({ error: '변경 요청은 Hivelane 화면에서만 보낼 수 있습니다' }, 403);
      }
      const origin = c.req.header('origin');
      if (origin) {
        let oh = '';
        try { oh = new URL(origin).host; } catch { /* 잘못된 Origin */ }
        if (!oh || oh.toLowerCase() !== host.toLowerCase()) return c.json({ error: `허용되지 않은 출처: ${origin}` }, 403);
      }
    }
    const login = c.req.header('tailscale-user-login') ?? null;
    if (remote) {
      if (!login) return c.json({ error: '원격 접속은 Tailscale 사용자 기기에서만 할 수 있습니다' }, 403);
      const owner = store.getSettings().ownerLogin;
      store.setKv('last_remote_login', { login, at: new Date().toISOString() });
      if (/\.ts\.net$/i.test(host) && store.getKv<string | null>('public_url', null) !== `https://${host}`) store.setKv('public_url', `https://${host}`);
      if (!owner) return c.json({ error: `원격 접속 주인이 아직 등록되지 않았습니다. 맥에서 설정 › 원격 접속에서 ${login} 을(를) 주인으로 등록하세요.` }, 403);
      if (owner.toLowerCase() !== login.toLowerCase()) return c.json({ error: `허용되지 않은 계정입니다: ${login}` }, 403);
      c.set('access', 'remote');
    } else c.set('access', 'local');
    c.set('login', login);
    await next();
  });
  const localOnly = (c: Context<Env>) => { if (c.get('access') !== 'local') throw new HttpError(403, '이 작업은 맥에서만 할 수 있습니다(원격은 보기만)'); };

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
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
      teams: store.listTeams().map((t) => ({ ...store.teamView(t), resume_grace_until: orch.graceUntil(t.id) })), proposals: store.listProposals(), poBusy: po.busy, knowledgeCount: store.knowledgeCount(), poUnread: store.poUnread(), prs: d.prs?.prs ?? [], repos: d.repos?.repos ?? [], scripts: d.scripts?.list() ?? [], prErrors: d.prs?.problems ?? {}, vapidPublicKey: notifier.vapidPublicKey(),
    };
    return c.json(snap);
  });
  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    const queue: BusEvent[] = [];
    let wake: (() => void) | null = null;
    // 「상태 바뀜」은 연결마다 따로 모아 최대 300ms 에 한 번만 보낸다(전역 이벤트로 되돌리면 연결끼리 서로 증폭한다).
    let statePending = false;
    let stateTimer: NodeJS.Timeout | null = null;
    let lastState = 0;
    const MAX_QUEUE = 2000;
    const off = bus.onEvent((e) => {
      if (e.type === 'state') { statePending = true; wake?.(); return; }
      queue.push(e);
      if (queue.length > MAX_QUEUE) { queue.splice(0, queue.length - MAX_QUEUE); statePending = true; } // 느린 연결: 오래된 스트림 줄은 버리고 새로 받게 한다
      wake?.();
    });
    stream.onAbort(() => { off(); if (stateTimer) clearTimeout(stateTimer); wake?.(); });
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ version: VERSION }) });
    while (!stream.aborted) {
      if (!queue.length && !(statePending && !stateTimer)) await Promise.race([new Promise<void>((r) => { wake = r; }), stream.sleep(15000)]);
      wake = null;
      if (stream.aborted) break;
      const batch = queue.splice(0);
      for (const e of batch) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      if (statePending && !stateTimer) {
        const wait = 300 - (Date.now() - lastState);
        if (wait <= 0) { statePending = false; lastState = Date.now(); await stream.writeSSE({ event: 'state', data: '{}' }); }
        else stateTimer = setTimeout(() => { stateTimer = null; wake?.(); }, wait);
      }
      if (!batch.length && !statePending) await stream.writeSSE({ event: 'ping', data: '' });
    }
    off();
    if (stateTimer) clearTimeout(stateTimer);
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
  app.get('/api/system/diag', async (c) => {
    const { CpuMeter, cwdsOf, diagnoseData, listProcDetails, memPercent } = await import('../po/resources.ts');
    const { cpus, loadavg } = await import('node:os');
    const meter = new CpuMeter();
    await new Promise((r) => setTimeout(r, 800));
    const cpu = meter.sample();
    const [procs, mem] = await Promise.all([listProcDetails(), memPercent()]);
    const teamRoots = new Map<number, string>();
    for (const t of store.listTeams("state IN ('running','paused','reviving','idle','waiting_human')")) for (const pid of orch.rootPids(t.id)) teamRoots.set(pid, `Hivelane 팀 「${t.name}」`);
    const input = { procs, cpu, mem, load: loadavg()[0] ?? 0, cores: cpus().length, teamRoots, hivelanePid: process.pid };
    const first = diagnoseData(input);
    return c.json(diagnoseData({ ...input, cwdOf: await cwdsOf(first.origins) }).data);
  });
  /* ---------- 스크립트 버튼 (등록·수정은 맥에서만, 실행은 원격도) ---------- */
  const scripts = () => { if (!d.scripts) throw new HttpError(409, '스크립트 기능이 꺼져 있습니다'); return d.scripts; };
  const scriptZ = z.object({ project_id: z.string().nullable(), name: z.string().trim().min(1).max(60), command: z.string().trim().min(1).max(4000), cwd: z.string().max(500).default(''), confirm: z.boolean().default(false) });
  app.post('/api/scripts', async (c) => { localOnly(c); const b = await body(c, scriptZ); return c.json(scripts().save(b)); });
  app.patch('/api/scripts/:id', async (c) => { localOnly(c); const b = await body(c, scriptZ); if (!scripts().get(c.req.param('id'))) throw new HttpError(404, '없는 스크립트입니다'); return c.json(scripts().save({ ...b, id: c.req.param('id') })); });
  app.delete('/api/scripts/:id', (c) => { localOnly(c); try { return c.json({ ok: scripts().remove(c.req.param('id')) }); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } });
  app.post('/api/scripts/:id/run', (c) => { try { return c.json({ run_id: scripts().run(c.req.param('id'), c.get('access')) }); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } });
  app.get('/api/scripts/:id/runs', (c) => c.json(scripts().runs(c.req.param('id'))));
  app.get('/api/script-runs/:id', (c) => { const r = scripts().getRun(Number(c.req.param('id'))); if (!r) throw new HttpError(404, '없는 실행입니다'); return c.json(r); });
  app.post('/api/script-runs/:id/stop', (c) => c.json({ ok: scripts().stop(Number(c.req.param('id'))) }));
  app.get('/api/projects/:id/npm-scripts', (c) => { const p = store.getProject(c.req.param('id')); if (!p) throw new HttpError(404, '프로젝트가 없습니다'); return c.json(scripts().npmScripts(p.path)); });
  app.post('/api/repos/refresh', async (c) => { await d.repos?.refresh(true); return c.json({ ok: true }); });
  app.post('/api/repos/:id/pull', async (c) => {
    if (!d.repos) throw new HttpError(409, '저장소 감시가 꺼져 있습니다');
    const r = await d.repos.pull(c.req.param('id'));
    if (!r.ok) throw new HttpError(409, `받지 못했습니다: ${r.message}`);
    return c.json(r);
  });
  app.post('/api/prs/merge', async (c) => {
    const b = await body(c, z.object({ project_id: z.string(), number: z.number().int().positive(), method: z.enum(['merge', 'squash', 'rebase']) }));
    if (!d.prs) throw new HttpError(409, 'PR 감시가 꺼져 있습니다');
    const r = await d.prs.merge(b.project_id, b.number, b.method);
    if (!r.ok) throw new HttpError(409, `병합하지 못했습니다: ${r.message}`);
    return c.json(r);
  });
  app.post('/api/prs/refresh', async (c) => { await d.prs?.refresh(); return c.json({ ok: true, at: d.prs?.lastAt ?? null }); });
  app.post('/api/presence', async (c) => {
    const b = await body(c, z.object({ device: z.string().min(4).max(60), view: z.string().max(80).nullable() }));
    notifier.presence?.(b.device, b.view);
    return c.json({ ok: true });
  });
  app.post('/api/seen', async (c) => {
    const b = await body(c, z.object({ team_id: z.string().optional(), po: z.boolean().optional(), up_to: z.number().int().optional() }));
    if (b.team_id) store.markTeamSeen(b.team_id, b.up_to);
    if (b.po) store.markPoSeen(b.up_to);
    return c.json({ ok: true });
  });
  app.post('/api/po/cancel', async (c) => c.json({ ok: await po.cancel() }));
  /* ---------- 이미지 첨부 ---------- */
  app.post('/api/uploads', async (c) => {
    const b = await body(c, z.object({ type: z.string(), data: z.string().max(14_500_000) }));
    try { const id = saveUpload(cfg, b.type, b.data); return c.json({ id, url: `/api/uploads/${id}` }); }
    catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
  });
  app.get('/api/uploads/:id', (c) => {
    const f = readUpload(cfg, c.req.param('id'));
    if (!f) throw new HttpError(404, '없는 파일입니다');
    return c.body(new Uint8Array(f.buf), 200, { 'content-type': f.type, 'cache-control': 'private, max-age=31536000, immutable' });
  });
  app.post('/api/chat', async (c) => { const b = await body(c, z.object({ text: z.string().min(1).max(8000) })); po.say(b.text); return c.json({ ok: true }); });

  /* ---------- PO 가 배운 것 ---------- */
  app.get('/api/knowledge', (c) => c.json(store.listKnowledge()));
  app.patch('/api/knowledge/:id', async (c) => {
    const b = await body(c, z.object({ kind: z.enum(['skill', 'note']).optional(), name: z.string().trim().min(1).max(80).optional(), when_to_use: z.string().max(500).optional(), body: z.string().min(1).max(20000).optional() }));
    try { const k = store.updateKnowledge(c.req.param('id'), b); if (!k) throw new HttpError(404, '없는 항목입니다'); return c.json(k); }
    catch (e) { if (e instanceof Error && /UNIQUE/.test(e.message)) throw new HttpError(409, '같은 이름이 이미 있습니다'); throw e; }
  });
  app.delete('/api/knowledge/:id', (c) => { if (!store.deleteKnowledge(c.req.param('id'))) throw new HttpError(404, '없는 항목입니다'); return c.json({ ok: true }); });

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
  app.patch('/api/teams/:id/env', async (c) => {
    localOnly(c);
    const t = team(c.req.param('id'));
    const b = await body(c, z.object({ env_mode: z.enum(['isolated', 'mine']) }));
    store.updateTeam(t.id, { env_mode: b.env_mode });
    store.addDecision(t.id, 'user', 'env', b.env_mode === 'mine' ? '작업 환경: 내 Claude Code 와 동일' : '작업 환경: 격리');
    return c.json({ ok: true });
  });
  app.post('/api/teams/:id/interrupt', async (c) => { team(c.req.param('id')); return c.json({ ok: await orch.cancelTurn(c.req.param('id')) }); });
  app.post('/api/teams/:id/cancel', async (c) => { const t = team(c.req.param('id')); if (t.lifetime === 'standing') await orch.endStanding(t.id, 'user', '사용자가 화면에서 종료'); else await orch.cancel(t.id); return c.json({ ok: true }); });
  app.post('/api/teams/:id/archive', async (c) => { localOnly(c); team(c.req.param('id')); await orch.archive(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/teams/:id/retry', async (c) => {
    const t = team(c.req.param('id'));
    if (t.state !== 'failed') throw new HttpError(409, '실패한 팀만 다시 시작할 수 있습니다');
    store.updateTeam(t.id, { state: 'queued', error: null, finished_at: null, nudges: 0, question: null });
    if (t.task_id) store.updateTask(t.task_id, { status: 'open', finished_at: null });
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
    git_mode: z.enum(['none', 'push']).optional(), protected_branches: z.array(z.string().min(1).max(100)).max(20).optional(),
  });
  app.post('/api/projects', async (c) => {
    localOnly(c);
    const b = await body(c, projectZ);
    const info = await inspectRepo(b.path);
    if (store.listProjects().some((p) => p.path === info.root)) throw new HttpError(409, '이미 등록된 경로입니다');
    const p = store.insertProject({
      name: b.name ?? info.name, path: info.root, base_ref: b.base_ref ?? info.baseRef, deps_strategy: b.deps_strategy, heavy_patterns: b.heavy_patterns ?? DEFAULT_HEAVY,
      blocked_patterns: b.blocked_patterns ?? DEFAULT_BLOCKED, memory_paths: b.memory_paths ?? info.memoryPaths, default_template_id: b.default_template_id ?? 'tpl-dev',
      git_mode: b.git_mode ?? 'none', protected_branches: b.protected_branches ?? ['prod', 'main', 'master'],
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
    autoApprove: z.boolean(), defaultBudgetUsd: z.number().positive().max(10000).nullable(), poModel: z.enum(['opus', 'sonnet', 'haiku']), contextLimitTokens: z.number().int().min(20000).max(1_000_000),
    remindUnreadMin: z.number().int().min(0).max(1440), ownerLogin: z.string().max(200).nullable(), slackWebhook: z.string().url().nullable().or(z.literal('').transform(() => null)),
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
  app.post('/api/push/test', async (c) => {
    const b = await body(c, z.object({ endpoint: z.string().url().optional() }));
    if (b.endpoint && notifier.sendTo) return c.json(await notifier.sendTo(b.endpoint, { title: '기기 점검', body: '이 알림이 보이면 이 기기 푸시가 정상입니다.', level: 'info', tag: 'push-check' }));
    await notifier.send({ title: '알림 시험', body: '이 알림이 보이면 설정이 끝났습니다.', level: 'info' });
    return c.json({ ok: true });
  });
  app.post('/api/push/report', async (c) => {
    const b = await body(c, z.object({ ua: z.string().max(300), steps: z.array(z.string().max(400)).max(20) }));
    pushLog.info(`기기 점검 결과 · ${b.ua}\n  ${b.steps.join('\n  ')}`);
    return c.json({ ok: true });
  });
  app.post('/api/push/check', async (c) => {
    const b = await body(c, z.object({ endpoint: z.string().url() }));
    return c.json({ known: store.pushSubs().some((s) => s.endpoint === b.endpoint) });
  });

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
