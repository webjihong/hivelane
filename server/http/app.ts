import { existsSync, readFileSync } from 'node:fs';
import { readUpload, saveUpload } from '../uploads.ts';
import type { PrWatcher } from '../projects/prs.ts';
import type { RepoWatcher } from '../projects/repos.ts';
import type { ScriptRunner } from '../scripts.ts';
import type { PlanUsage } from '../po/usage.ts';
import type { AuthLogin } from '../po/auth.ts';
import type { AccountManager } from '../accounts.ts';
import type { GitCleanWatcher } from '../projects/cleanwatch.ts';
import { readPatch } from '../projects/archive.ts';
import { run } from '../util.ts';
import { tailscaleState } from '../remote.ts';
import { compactDb, storageReport } from '../storage.ts';
import { createGithubRepo, githubAccounts, linkRemoteUrl } from '../projects/link.ts';
import type { OllamaManager } from '../search/ollama.ts';
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
import { diffText, initRepo, inspectRepo } from '../projects/git.ts';
import type { Search } from '../search/index.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY, type Store } from '../store.ts';
import { ConflictError, type Orchestrator } from '../teams/orchestrator.ts';
import type { Priority, StateSnapshot, TemplateRole } from '../../shared/types.ts';

const log = logger('http');
const VERSION = '0.1.0';

export interface AppDeps { cfg: AppConfig; store: Store; orch: Orchestrator; engine: Engine; po: PoAgent; search: Search; notifier: Notifier; prs?: PrWatcher; repos?: RepoWatcher; scripts?: ScriptRunner; usage?: PlanUsage; auth?: AuthLogin; gitClean?: GitCleanWatcher; ollama?: OllamaManager; accounts?: AccountManager }
type Env = { Bindings: HttpBindings; Variables: { access: 'local' | 'remote'; login: string | null } };

const roleZ = z.object({ key: z.string().min(1).max(20).regex(/^[a-z0-9_-]+$/), name: z.string().min(1).max(20), model: z.enum(['opus', 'sonnet', 'haiku']), mode: z.enum(['session', 'subagent']), tools: z.enum(['pm', 'write', 'verify', 'read']), prompt: z.string().max(4000).optional(), account: z.string().max(40).nullable().optional() });
const priorityZ = z.enum(['urgent', 'normal', 'low']);

class HttpError extends Error { constructor(public status: 400 | 403 | 404 | 409, msg: string) { super(msg); } }

const pushLog = logger('push');

/** 스냅샷엔 일하는 팀 전부 + 끝난 팀은 최근 것(7일 안 또는 최근 20개)만. 나머지는 /api/finished-teams 로 */
export function snapshotTeams<T extends { lifetime: string; state: string; finished_at: string | null; updated_at: string }>(all: T[], now = Date.now()): T[] {
  const fin = (t: T) => t.lifetime === 'task' && (t.state === 'done' || t.state === 'failed');
  const at = (t: T) => Date.parse(t.finished_at ?? t.updated_at) || 0;
  const recent = new Set(all.filter(fin).sort((a, b) => at(b) - at(a)).filter((t, i) => i < 20 || now - at(t) < 7 * 86_400_000));
  return all.filter((t) => !fin(t) || recent.has(t));
}

const httpLog = logger('http');

/** 지금 서버가 내보내는 화면 빌드(index.html 이 부르는 /assets 스크립트 이름). 화면이 자기 것과 다르면 새로 불러온다. */
export function webBuild(dir: string): string | null {
  try { return readFileSync(join(dir, 'index.html'), 'utf8').match(/\/assets\/[\w.-]+\.js/)?.[0] ?? null; } catch { return null; }
}

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
    const r = await gate(c, next);
    const res = r instanceof Response ? r : c.res;
    if (res.status === 403) {
      // 원격 기기에서 왜 막혔는지 맥에서 볼 수 있게 남긴다
      let why = '';
      try { why = ((await res.clone().json()) as { error?: string }).error ?? ''; } catch { /* 본문 없음 */ }
      httpLog.warn(`403 ${c.req.method} ${c.req.path} · ${why} · ${(c.req.header('user-agent') ?? '').slice(0, 80)}`);
    }
    return r instanceof Response ? r : undefined;
  });
  const gate = async (c: Context<Env>, next: () => Promise<void>): Promise<Response | void> => {
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
  };
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
      version: VERSION, access: c.get('access'), settings: store.getSettings(), resource: engine.last, usage: d.usage?.last ?? { available: false, plan: null, windows: [], takenAt: null, error: null }, gitClean: d.gitClean?.summary ?? { remove: 0, ask: 0, takenAt: null, running: false }, projects: store.listProjects(), templates: store.listTemplates(),
      teams: snapshotTeams(store.listTeams()).map((t) => ({ ...store.teamView(t), resume_grace_until: orch.graceUntil(t.id) })), finishedCount: store.finishedCount(), proposals: store.listProposals(), poBusy: po.busy, knowledgeCount: store.knowledgeCount(), poUnread: store.poUnread(), prs: d.prs?.prs ?? [], repos: d.repos?.repos ?? [], scripts: d.scripts?.list() ?? [], prErrors: d.prs?.problems ?? {}, vapidPublicKey: notifier.vapidPublicKey(),
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
    // 맥 앱(Electron) 화면이면 연결된 동안 맥 브라우저 웹 푸시를 건너뛰게 센다
    const desktop = /\bElectron\//.test(c.req.header('user-agent') ?? '');
    let counted = false;
    if (desktop && notifier.desktopOnline) { notifier.desktopOnline(1); counted = true; }
    const uncount = () => { if (counted) { counted = false; notifier.desktopOnline?.(-1); } };
    stream.onAbort(() => { off(); uncount(); if (stateTimer) clearTimeout(stateTimer); wake?.(); });
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
    uncount();
    if (stateTimer) clearTimeout(stateTimer);
  }));

  app.get('/api/teams/:id', (c) => { const dt = store.teamDetail(c.req.param('id')); if (!dt) throw new HttpError(404, '팀이 없습니다'); return c.json(dt); });
  app.get('/api/agents/:id', (c) => { const dt = store.agentDetail(c.req.param('id')); if (!dt) throw new HttpError(404, '에이전트가 없습니다'); return c.json(dt); });
  app.get('/api/teams/:id/diff', async (c) => {
    const t = team(c.req.param('id'));
    if (!t.worktree_path || !t.base_sha) {
      // worktree 를 정리한 팀: 남겨 둔 패치에서 보여 준다
      const patch = store.teamPatch(t.id);
      return c.json({ diff: patch ? readPatch(patch, c.req.query('path') || undefined) : '', from_patch: !!patch });
    }
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
  /* ---------- 끝난 팀 전체·정리 기록 ---------- */
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };
  app.get('/api/finished-teams', (c) => c.json(store.finishedTeams({ q: c.req.query('q') ?? '', state: c.req.query('state') ?? '', projectId: c.req.query('project') || null, offset: num(c.req.query('offset'), 0), limit: num(c.req.query('limit'), 50) })));
  app.get('/api/cleanup-log', (c) => c.json(store.cleanupLog({ projectId: c.req.query('project') || null, teamId: c.req.query('team') || null, offset: num(c.req.query('offset'), 0), limit: num(c.req.query('limit'), 50) })));
  app.get('/api/cleanup-log/:id/patch', (c) => {
    const row = store.cleanupLogRow(Number(c.req.param('id')));
    if (!row?.patch_path) throw new HttpError(404, '남겨 둔 패치가 없습니다');
    return c.json({ patch: readPatch(row.patch_path, c.req.query('path') || undefined), path: row.patch_path });
  });
  /* ---------- worktree·로컬 브랜치 정리(화면) ---------- */
  const gc = () => { if (!d.gitClean) throw new HttpError(404, '정리 기능을 쓸 수 없습니다'); return d.gitClean; };
  app.get('/api/git-clean', async (c) => { if (c.req.query('refresh')) await gc().refresh(); return c.json({ summary: gc().summary, scans: gc().views }); });
  app.post('/api/teams/:id/clean-worktree', async (c) => {
    localOnly(c);
    team(c.req.param('id'));
    const b = await body(c, z.object({ discard: z.boolean().default(false) }));
    return c.json(await gc().cleanTeam(c.req.param('id'), b.discard));
  });
  app.post('/api/git-clean/apply', async (c) => {
    localOnly(c);
    const b = await body(c, z.object({ project_id: z.string().min(1), ids: z.array(z.string().min(3)).min(1).max(500), discard: z.boolean().default(false) }));
    const lines = await gc().apply(b.project_id, b.ids, b.discard);
    return c.json({ lines, summary: gc().summary, scans: gc().views });
  });
  /* ---------- AI 계정 여러 개(계정별 로그인·사용량, 역할·총괄이 고름) ---------- */
  const accts = () => { if (!d.accounts) throw new HttpError(404, '계정 기능을 쓸 수 없습니다'); return d.accounts; };
  /** 계정을 쓰는 곳: 템플릿 역할·직속/업무 팀 역할·총괄 */
  const usedBy = (id: string): string[] => {
    const s = store.getSettings();
    const def = accts().resolve(null).id;
    const pick = (a: string | null | undefined) => (accts().get(a) ? a : def);
    const out: string[] = [];
    if (pick(s.poAccount) === id) out.push('총괄');
    // Agent 도구로 부르는 팀원(subagent)은 PM 계정을 쓰므로 PM·독립 세션 역할만 센다 · 템플릿 이름으로 묶는다
    for (const t of store.listTemplates()) {
      const roles = t.roles.filter((r) => (r.key === 'pm' || r.mode === 'session') && pick(r.account) === id).map((r) => r.name);
      if (roles.length) out.push(`${t.name}(${roles.join('·')})`);
    }
    return out;
  };
  app.get('/api/accounts', (c) => c.json({ accounts: accts().views(usedBy) }));
  app.post('/api/accounts', async (c) => { localOnly(c); const b = await body(c, z.object({ name: z.string().min(1).max(40) })); const a = accts().add(b.name, 'claude'); return c.json({ account: a }); });
  app.patch('/api/accounts/:id', async (c) => { localOnly(c); const b = await body(c, z.object({ name: z.string().min(1).max(40) })); try { return c.json({ account: accts().rename(c.req.param('id'), b.name) }); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } });
  app.delete('/api/accounts/:id', (c) => { localOnly(c); try { accts().remove(c.req.param('id')); return c.json({ ok: true }); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } });
  app.post('/api/accounts/:id/refresh', async (c) => { await accts().usage(c.req.param('id')).refresh(); return c.json({ accounts: accts().views(usedBy) }); });
  app.post('/api/accounts/:id/login', (c) => { localOnly(c); try { return c.json(accts().login(c.req.param('id')).start()); } catch (e) { throw new HttpError(404, e instanceof Error ? e.message : String(e)); } });
  app.post('/api/accounts/:id/login/code', async (c) => { localOnly(c); const b = await body(c, z.object({ code: z.string().min(4).max(2000) })); try { return c.json(accts().login(c.req.param('id')).code(b.code)); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } });
  app.post('/api/accounts/:id/login/cancel', (c) => { localOnly(c); return c.json(accts().login(c.req.param('id')).cancel()); });

  /* ---------- Claude 재로그인(claude auth login 대행: 링크 보여 주고 코드 받기) ---------- */
  const auth = () => { if (!d.auth) throw new HttpError(404, '재로그인을 쓸 수 없습니다'); return d.auth; };
  app.get('/api/auth/login', (c) => c.json(auth().view));
  app.post('/api/auth/login', (c) => c.json(auth().start()));
  app.post('/api/auth/login/code', async (c) => { const b = await body(c, z.object({ code: z.string().min(4).max(2000) })); try { return c.json(auth().code(b.code)); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } });
  app.post('/api/auth/login/cancel', (c) => c.json(auth().cancel()));
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
  // 수정: 보낸 값만 바꾼다(기본값을 채우지 않도록 따로 정의 · roles 는 받지 않음)
  const standingPatchZ = z.object({
    name: z.string().min(1).max(60).optional(), project_id: z.string().nullable().optional(), template_id: z.string().min(1).optional(),
    brief: z.string().max(8000).optional(), check_command: z.string().max(2000).nullable().optional(), check_interval_sec: z.number().int().min(30).max(86400).nullable().optional(),
    readable_team_ids: z.array(z.string()).optional(),
  });
  app.patch('/api/standing/:id', async (c) => { localOnly(c); const b = await body(c, standingPatchZ); await orch.updateStanding(c.req.param('id'), b, '사용자'); return c.json({ ok: true }); });

  /* ---------- 프로젝트 ---------- */
  /** 맥에서 Finder 폴더 고르기 창을 띄운다(맥 화면에서만 · 취소하면 path null) */
  app.post('/api/pick-folder', async (c) => {
    localOnly(c);
    const b = await body(c, z.object({ prompt: z.string().max(100).default('폴더 고르기') }));
    // activate: 창이 다른 앱 뒤에 숨지 않게 앞으로(권한 필요 없음)
    const script = `activate\ntry\n  set f to choose folder with prompt ${JSON.stringify(b.prompt)} default location (path to home folder)\n  return POSIX path of f\non error number -128\n  return ""\nend try`;
    const out = await run('osascript', ['-e', script], { timeoutMs: 300_000 });
    if (out.code !== 0) throw new HttpError(409, `폴더 창을 띄우지 못했습니다: ${out.stderr.trim().slice(0, 200)}`);
    const path = out.stdout.trim().replace(/\/$/, '');
    return c.json({ path: path || null });
  });
  /* ---------- 원격 저장소 연결(원격이 없을 때) ---------- */
  app.get('/api/github/accounts', async (c) => c.json({ accounts: await githubAccounts() }));
  app.post('/api/projects/:id/remote', async (c) => {
    localOnly(c);
    // :id 가 「path」 면 등록 전 폴더(body.path)에 연결
    const pre = c.req.param('id') === 'path';
    const raw = pre ? ((await c.req.raw.clone().json().catch(() => ({}))) as { path?: string }).path : null;
    const p = pre ? (raw ? { name: raw.split('/').pop() ?? raw, path: (await inspectRepo(raw)).root } : null) : store.getProject(c.req.param('id'));
    if (!p) throw new HttpError(404, '프로젝트가 없습니다');
    const b = await body(c, z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('url'), url: z.string().min(5).max(500), push: z.boolean().default(true), path: z.string().optional() }),
      z.object({ mode: z.literal('github'), path: z.string().optional(), account: z.string().max(60).optional(), owner: z.string().max(60).optional(), name: z.string().min(1).max(100), visibility: z.enum(['private', 'public']).default('private'), description: z.string().max(200).optional() }),
    ]));
    try {
      const r = b.mode === 'url' ? await linkRemoteUrl(p.path, b.url, b.push) : await createGithubRepo(p.path, b);
      store.addChat({ role: 'event', body: `원격 저장소 연결 · ${p.name} → ${r.remote.label}\n${r.log.join('\n')}`, tone: 'good' });
      void d.repos?.refresh(true);
      return c.json(r);
    } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); }
  });
  app.post('/api/projects/inspect', async (c) => {
    localOnly(c);
    const b = await body(c, z.object({ path: z.string().min(1) }));
    try { return c.json(await inspectRepo(b.path)); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('git 저장소가 아닙니다')) return c.json({ notGit: true, path: msg.replace(/^git 저장소가 아닙니다:\s*/, '') });
      throw new HttpError(400, msg);
    }
  });
  app.post('/api/projects/git-init', async (c) => {
    localOnly(c);
    const b = await body(c, z.object({ path: z.string().min(1) }));
    try { return c.json(await initRepo(b.path)); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); }
  });
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
    remindUnreadMin: z.number().int().min(0).max(1440), autoCleanDays: z.number().int().min(0).max(365), ownerLogin: z.string().max(200).nullable(), slackWebhook: z.string().url().nullable().or(z.literal('').transform(() => null)),
    embedding: z.object({ provider: z.enum(['off', 'ollama', 'voyage']), model: z.string().max(100), url: z.string().max(200) }).partial(),
    defaultAccount: z.string().max(40), poAccount: z.string().max(40).nullable(),
  }).partial();
  app.put('/api/settings', async (c) => {
    localOnly(c);
    const b = await body(c, settingsZ);
    const before = store.getSettings().embedding;
    const saved = store.saveSettings(b as Parameters<Store['saveSettings']>[0]);
    if (before.provider !== saved.embedding.provider || before.url !== saved.embedding.url) void d.ollama?.ensure(); // Ollama 를 고르면 켜고, 끄면 우리가 띄운 것만 끈다
    return c.json(saved);
  });
  /* ---------- 벡터 검색용 Ollama(설치·켜기·모델 받기) ---------- */
  const ol = () => { if (!d.ollama) throw new HttpError(404, 'Ollama 관리를 쓸 수 없습니다'); return d.ollama; };
  const olDo = (f: () => unknown) => { try { f(); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } };
  app.get('/api/ollama', async (c) => c.json(await ol().status()));
  app.post('/api/ollama/install', async (c) => { localOnly(c); olDo(() => ol().install()); return c.json(await ol().status()); });
  app.post('/api/ollama/start', async (c) => { localOnly(c); try { await ol().start(); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } return c.json(await ol().status()); });
  app.post('/api/ollama/stop', async (c) => { localOnly(c); ol().stop(); return c.json(await ol().status()); });
  app.post('/api/ollama/pull', async (c) => { localOnly(c); const b = await body(c, z.object({ model: z.string().min(1).max(100) })); olDo(() => ol().pull(b.model)); return c.json(await ol().status()); });
  app.get('/api/remote', async (c) => c.json({ ownerLogin: store.getSettings().ownerLogin, lastRemote: store.getKv('last_remote_login', null), remotePort: d.cfg.remotePort, tailscale: await tailscaleState(d.cfg.remotePort, !!c.req.query('fresh')).catch(() => null) }));
  app.post('/api/search/reindex', (c) => { localOnly(c); try { return c.json(search.startReindex()); } catch (e) { throw new HttpError(409, e instanceof Error ? e.message : String(e)); } });
  app.get('/api/search/status', (c) => c.json(search.status()));
  app.get('/api/storage', async (c) => c.json(await storageReport(cfg, store, !!c.req.query('fresh'))));
  app.post('/api/storage/compact', (c) => { localOnly(c); return c.json(compactDb(store)); });
  app.get('/api/search', async (c) => c.json(await search.search(c.req.query('q') ?? '', { projectId: c.req.query('project') || null })));

  /* ---------- 푸시 ---------- */
  app.post('/api/push/subscribe', async (c) => {
    const b = await body(c, z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), device: z.string().max(100).default('') }));
    store.addPushSub(b.endpoint, b.keys, b.device);
    httpLog.info(`푸시 구독 저장 · ${b.device} · ${(() => { try { return new URL(b.endpoint).host; } catch { return '?'; } })()}`);
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

  // 화면 진단: 기기에서 화면이 가로로 넘치면 무엇이 넘치는지 서버 기록(logs/server.log)에 남긴다(넘칠 때만 온다)
  app.post('/api/client/layout', async (c) => {
    const b = await body(c, z.object({ ua: z.string().max(400), standalone: z.boolean(), build: z.string().max(200).nullable(), vw: z.number(), dpr: z.number(), fontPx: z.number(), doc: z.number(), main: z.number().nullable(), chat: z.number().nullable(), over: z.array(z.string().max(300)).max(15) }));
    log.info(`화면 진단 · ${b.standalone ? '설치 앱' : '브라우저'} · ${b.ua}\n  빌드 ${b.build} · 화면 ${b.vw}px · dpr ${b.dpr} · 기본 글자 ${b.fontPx}px · 문서 ${b.doc} · 본문 ${b.main} · 대화창 ${b.chat}${b.over.length ? `\n  넘침:\n  ${b.over.join('\n  ')}` : ''}`);
    return c.json({ ok: true });
  });
  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, build: webBuild(cfg.webDist) }));

  /* ---------- 화면 ---------- */
  if (existsSync(cfg.webDist)) {
    // 이름에 내용 해시가 붙은 /assets 는 오래 캐시, 나머지(index.html·sw.js·manifest)는 매번 새로 확인한다.
    // 홈 화면 앱(PWA)이 예전 index.html 을 붙잡고 예전 화면을 계속 보여 주는 것을 막는다.
    app.use('/*', async (c, next) => {
      await next();
      if (c.req.path.startsWith('/api/')) return;
      c.res.headers.set('Cache-Control', c.req.path.startsWith('/assets/') && c.res.status === 200 ? 'public, max-age=31536000, immutable' : 'no-cache');
    });
    app.use('/*', serveStatic({ root: cfg.webDist, rewriteRequestPath: (p) => p }));
    const index = join(cfg.webDist, 'index.html');
    app.get('*', (c) => c.html(readFileSync(index, 'utf8')));
  } else {
    app.get('/', (c) => c.text('화면이 빌드되지 않았습니다. `npm run build` 후 다시 열거나, 개발 중이면 http://127.0.0.1:4311 을 여세요.'));
  }
  return app;
}
