/**
 * 백업: 그 순간의 기록 전체(DB 스냅숏 + 올린 이미지 + 정리한 패치)를 파일 하나(tar.gz)로 묶어 저장소에 올린다.
 * - 설정은 DB 가 아니라 ~/.hivelane/backup.json 에 둔다(복구로 DB 를 바꿔도 백업 설정은 그대로).
 * - 비밀값(WebDAV 비밀번호·S3 비밀 키)은 맥 키체인에만.
 * - 주기: 끄기/매일/매주(요일)+시각. 맥이 잠들어 놓친 백업은 깨어나는 대로 바로 한다. 바뀐 게 없으면 건너뜀(선택).
 * - 열어 보기: 백업을 받아 풀어 읽기 전용 DB 로 연다(지금 기록은 그대로).
 * - 복구: 직전에 지금 상태를 백업 → 받아 풀어 restore-pending 에 두고 → 서버를 다시 띄우면 시작할 때 바꿔 끼운다.
 */
import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupConfig, BackupItem, BackupRunResult, BackupTarget, BackupView } from '../../shared/types.ts';
import type { AppConfig } from '../config.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';
import { newId, nowIso, run } from '../util.ts';
import { BACKUP_RE, makeTarget, type TargetIO } from './targets.ts';

const log = logger('backup');

export const DEFAULT_BACKUP: BackupConfig = { schedule: { mode: 'off', time: '03:00', weekday: 1, everyMin: 60 }, keep: 14, skipUnchanged: true, targets: [] };

/** 비밀값 보관(기본: 맥 키체인). 테스트는 메모리로 바꾼다 */
export interface SecretStore { get(id: string): Promise<string | null>; set(id: string, v: string): Promise<void>; del(id: string): Promise<void> }
const SERVICE = 'hivelane-backup';
export const keychain: SecretStore = {
  async get(id) { const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w']); return r.code === 0 ? r.stdout.replace(/\n$/, '') : null; },
  async set(id, v) { const r = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', id, '-w', v]); if (r.code !== 0) throw new Error(`키체인 저장 실패: ${r.stderr.trim()}`); },
  async del(id) { await run('security', ['delete-generic-password', '-s', SERVICE, '-a', id]); },
};

/** 예정 시각 계산: now 이전 가장 최근 예정 시각과 다음 예정 시각 */
export function scheduleTimes(s: BackupConfig['schedule'], now: Date): { lastDue: Date | null; next: Date | null } {
  if (s.mode === 'off') return { lastDue: null, next: null };
  if (s.mode === 'interval') {
    // 자정부터 everyMin 분 간격(30분이면 :00·:30, 6시간이면 0·6·12·18시)
    const every = Math.max(15, Math.min(1440, s.everyMin || 60));
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const k = Math.floor((now.getTime() - midnight.getTime()) / 60_000 / every);
    const lastDue = new Date(midnight.getTime() + k * every * 60_000);
    let next = new Date(lastDue.getTime() + every * 60_000);
    // 하루가 간격으로 나누어떨어지지 않으면 자정에서 다시 맞춘다
    const nextMidnight = new Date(midnight); nextMidnight.setDate(nextMidnight.getDate() + 1);
    if (next > nextMidnight) next = nextMidnight;
    return { lastDue, next };
  }
  const [hh, mm] = s.time.split(':').map((x) => Number(x));
  const at = (d: Date) => { const x = new Date(d); x.setHours(hh ?? 3, mm ?? 0, 0, 0); return x; };
  const step = s.mode === 'daily' ? 1 : 7;
  let cand = at(now);
  if (s.mode === 'weekly') { const diff = (cand.getDay() - s.weekday + 7) % 7; cand.setDate(cand.getDate() - diff); }
  if (cand > now) cand.setDate(cand.getDate() - step);
  const next = new Date(cand); next.setDate(next.getDate() + step);
  return { lastDue: cand, next };
}

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

type State = { last: BackupRunResult | null; lastAttemptAt: string | null; lastSig: string | null };

export class BackupManager {
  private running: Promise<BackupRunResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private views = new Map<string, { db: Database.Database; dir: string; name: string; target: string; openedAt: number }>();
  private secrets: SecretStore;
  private file: string;
  private stateFile: string;

  constructor(private deps: { cfg: AppConfig; store: Store; onChange: () => void; secrets?: SecretStore; fetchFn?: typeof fetch; notify?: (title: string, body: string, ok: boolean) => void; exit?: () => void }) {
    this.secrets = deps.secrets ?? keychain;
    this.file = join(deps.cfg.home, 'backup.json');
    this.stateFile = join(deps.cfg.home, 'backup-state.json');
  }

  config(): BackupConfig {
    try { const c = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BackupConfig>; return { ...DEFAULT_BACKUP, ...c, schedule: { ...DEFAULT_BACKUP.schedule, ...(c.schedule ?? {}) }, targets: c.targets ?? [] }; } catch { return { ...DEFAULT_BACKUP, targets: [] }; }
  }
  private state(): State { try { return JSON.parse(readFileSync(this.stateFile, 'utf8')) as State; } catch { return { last: null, lastAttemptAt: null, lastSig: null }; } }
  private setState(p: Partial<State>): void { writeFileSync(this.stateFile, JSON.stringify({ ...this.state(), ...p }, null, 2)); }

  /** 설정 저장. secrets: 저장소 id → 새 비밀값(빈 문자열이면 지움) */
  async saveConfig(patch: Partial<BackupConfig>, secrets: Record<string, string> = {}): Promise<BackupConfig> {
    const cur = this.config();
    const next: BackupConfig = { ...cur, ...patch, schedule: { ...cur.schedule, ...(patch.schedule ?? {}) }, targets: patch.targets ?? cur.targets };
    for (const t of next.targets) if (!t.id) t.id = newId('bk');
    // 지운 저장소의 비밀값도 지운다
    for (const old of cur.targets) if (!next.targets.some((t) => t.id === old.id)) await this.secrets.del(old.id).catch(() => undefined);
    for (const [id, v] of Object.entries(secrets)) { if (v) await this.secrets.set(id, v); else await this.secrets.del(id); }
    if (patch.schedule && JSON.stringify(cur.schedule) !== JSON.stringify(next.schedule)) this.setState({ lastAttemptAt: nowIso() }); // 주기를 바꾸면 다음 예정부터
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    this.deps.onChange();
    return next;
  }

  private async io(t: BackupTarget): Promise<TargetIO> {
    return makeTarget(t, t.type === 'local' ? null : await this.secrets.get(t.id), this.deps.fetchFn);
  }

  /** 저장소 연결 시험: 작은 파일을 올리고 목록에서 보이는지 본 뒤 지운다 */
  async test(t: BackupTarget, secret?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const io = makeTarget(t, t.type === 'local' ? null : secret || (t.id ? await this.secrets.get(t.id) : null), this.deps.fetchFn);
      const name = `hivelane-backup-${stamp(new Date())}-test.tar.gz`;
      const f = join(tmpdir(), name);
      writeFileSync(f, 'hivelane backup test');
      await io.put(name, f);
      const seen = (await io.list()).some((x) => x.name === name);
      await io.del(name);
      rmSync(f, { force: true });
      return seen ? { ok: true } : { ok: false, error: '올렸지만 목록에서 보이지 않습니다' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  /** 기록이 바뀌었는지 보는 표지 */
  private signature(): string {
    const db = this.deps.store.db;
    const q = (sql: string) => { try { return (db.prepare(sql).get() as { n: number | null }).n ?? 0; } catch { return 0; } };
    return [q('SELECT max(id) n FROM messages'), q('SELECT max(id) n FROM agent_events'), q('SELECT max(id) n FROM po_chat'), q('SELECT count(*) n FROM teams'), q('SELECT max(id) n FROM work_summaries')].join(':');
  }

  /** 백업 파일 하나 만들기 → 켜진 저장소마다 올리고 보관 개수 넘는 것 지우기 */
  backupNow(reason: 'manual' | 'schedule' | 'before-restore' = 'manual'): Promise<BackupRunResult> {
    this.running ??= this.doBackup(reason).finally(() => { this.running = null; this.deps.onChange(); });
    this.deps.onChange();
    return this.running;
  }

  private async doBackup(reason: string): Promise<BackupRunResult> {
    const cfg = this.config();
    const targets = cfg.targets.filter((t) => t.enabled);
    const at = new Date();
    this.setState({ lastAttemptAt: at.toISOString() });
    const res: BackupRunResult = { at: at.toISOString(), ok: false, reason, file: null, size: 0, results: [] };
    if (!targets.length) { res.error = '켜진 저장소가 없습니다'; this.setState({ last: res }); return res; }
    const sig = this.signature();
    if (reason === 'schedule' && cfg.skipUnchanged && sig === this.state().lastSig) {
      const r = { ...res, ok: true, skipped: true };
      this.setState({ last: { ...r, error: undefined } });
      return r;
    }
    const work = join(tmpdir(), `hivelane-bk-${process.pid}-${Date.now()}`);
    const stage = join(work, 'data');
    mkdirSync(stage, { recursive: true });
    const name = `hivelane-backup-${stamp(at)}${reason === 'manual' || reason === 'schedule' ? '' : `-${reason}`}.tar.gz`;
    const out = join(work, name);
    try {
      await this.deps.store.db.backup(join(stage, 'hivelane.db')); // 쓰는 중에도 안전한 스냅숏(WAL 포함)
      for (const [src, dst] of [[this.deps.cfg.uploadsDir, 'uploads'], [join(this.deps.cfg.home, 'archive'), 'archive']] as const) {
        if (existsSync(src)) cpSync(src, join(stage, dst), { recursive: true });
      }
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ app: 'hivelane', format: 1, created_at: at.toISOString(), reason }, null, 2));
      const t = await run('tar', ['-czf', out, '-C', stage, '.'], { timeoutMs: 600_000 });
      if (t.code !== 0) throw new Error(`압축 실패: ${t.stderr.trim()}`);
      res.file = name; res.size = statSync(out).size;
      for (const target of targets) {
        try {
          const io = await this.io(target);
          await io.put(name, out);
          await this.prune(io, cfg.keep);
          res.results.push({ target: target.id, ok: true });
        } catch (e) { res.results.push({ target: target.id, ok: false, error: e instanceof Error ? e.message : String(e) }); }
      }
      res.ok = res.results.every((r) => r.ok);
      if (res.results.some((r) => r.ok)) this.setState({ lastSig: sig });
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    this.setState({ last: res });
    if (!res.ok) {
      const why = res.error ?? res.results.filter((r) => !r.ok).map((r) => `${cfg.targets.find((t) => t.id === r.target)?.name ?? r.target}: ${r.error}`).join(' · ');
      log.warn('백업 실패', why);
      this.deps.notify?.('백업 실패', why, false);
    } else log.info(`백업 완료 ${name} (${Math.round(res.size / 1024)}KB)`);
    return res;
  }

  /** 보관 개수 넘는 오래된 백업 지우기(복구 직전 백업도 개수에 든다) */
  private async prune(io: TargetIO, keep: number): Promise<void> {
    if (keep <= 0) return;
    const list = (await io.list()).filter((x) => BACKUP_RE.test(x.name)).sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const x of list.slice(keep)) await io.del(x.name).catch(() => undefined);
  }

  /** 모든 저장소의 백업 목록 */
  async list(): Promise<{ items: BackupItem[]; errors: Record<string, string> }> {
    const items: BackupItem[] = [];
    const errors: Record<string, string> = {};
    await Promise.all(this.config().targets.filter((t) => t.enabled).map(async (t) => {
      try { for (const x of await (await this.io(t)).list()) items.push({ ...x, target: t.id }); } catch (e) { errors[t.id] = e instanceof Error ? e.message : String(e); }
    }));
    items.sort((a, b) => (a.name < b.name ? 1 : -1));
    return { items, errors };
  }

  async view(): Promise<BackupView> {
    const cfg = this.config();
    const targets = await Promise.all(cfg.targets.map(async (t) => ({ ...t, hasSecret: t.type === 'local' ? true : !!(await this.secrets.get(t.id).catch(() => null)) })));
    const { items, errors } = await this.list();
    const st = this.state();
    return { config: { ...cfg, targets }, last: st.last, running: !!this.running, nextAt: scheduleTimes(cfg.schedule, new Date()).next?.toISOString() ?? null, items, listErrors: errors };
  }

  async remove(targetId: string, name: string): Promise<void> {
    const t = this.config().targets.find((x) => x.id === targetId);
    if (!t) throw new Error('없는 저장소입니다');
    await (await this.io(t)).del(name);
    this.deps.onChange();
  }

  /** 백업을 받아 풀기 */
  private async fetchAndExtract(targetId: string, name: string, dir: string): Promise<void> {
    const t = this.config().targets.find((x) => x.id === targetId);
    if (!t) throw new Error('없는 저장소입니다');
    if (!BACKUP_RE.test(name)) throw new Error('백업 파일 이름이 올바르지 않습니다');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    await (await this.io(t)).get(name, file);
    const r = await run('tar', ['-xzf', file, '-C', dir], { timeoutMs: 600_000 });
    rmSync(file, { force: true });
    if (r.code !== 0) throw new Error(`압축 풀기 실패: ${r.stderr.trim()}`);
    if (!existsSync(join(dir, 'hivelane.db'))) throw new Error('Hivelane 백업 파일이 아닙니다(hivelane.db 없음)');
  }

  /* ---------- 열어 보기(읽기 전용) ---------- */
  async open(targetId: string, name: string): Promise<string> {
    for (const [id, v] of this.views) if (v.name === name && v.target === targetId) { v.openedAt = Date.now(); return id; }
    const id = newId('bv');
    const dir = join(this.deps.cfg.home, 'backup-view', id);
    await this.fetchAndExtract(targetId, name, dir);
    const db = new Database(join(dir, 'hivelane.db'), { readonly: true, fileMustExist: true });
    this.views.set(id, { db, dir, name, target: targetId, openedAt: Date.now() });
    // 열어 둔 것은 3개까지(오래된 것부터 닫음)
    const extra = [...this.views.entries()].sort((a, b) => b[1].openedAt - a[1].openedAt).slice(3);
    for (const [k] of extra) this.close(k);
    return id;
  }

  close(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    try { v.db.close(); } catch { /* 이미 닫힘 */ }
    rmSync(v.dir, { recursive: true, force: true });
    this.views.delete(id);
  }

  private vdb(id: string): Database.Database {
    const v = this.views.get(id);
    if (!v) throw new Error('열린 백업이 없습니다. 다시 「열어 보기」를 누르세요');
    v.openedAt = Date.now();
    return v.db;
  }

  viewTeams(id: string, q = ''): { id: string; name: string; state: string; lifetime: string; created_at: string; finished_at: string | null; messages: number }[] {
    const like = `%${q}%`;
    return this.vdb(id).prepare(`SELECT t.id, t.name, t.state, t.lifetime, t.created_at, t.finished_at, (SELECT count(*) FROM messages m WHERE m.team_id = t.id) messages
      FROM teams t WHERE (? = '' OR t.name LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.team_id = t.id AND m.body LIKE ?)) ORDER BY t.created_at DESC LIMIT 300`).all(q, like, like) as never;
  }

  viewTeam(id: string, teamId: string): { team: Record<string, unknown> | null; messages: unknown[]; summaries: unknown[]; events: unknown[] } {
    const db = this.vdb(id);
    const team = db.prepare('SELECT id, name, state, lifetime, standing_brief, created_at, finished_at, cost_usd FROM teams WHERE id = ?').get(teamId) as Record<string, unknown> | undefined;
    const messages = db.prepare('SELECT id, from_label, to_label, kind, body, created_at FROM messages WHERE team_id = ? ORDER BY id LIMIT 2000').all(teamId);
    const summaries = db.prepare('SELECT id, stage, body, created_at FROM work_summaries WHERE team_id = ? ORDER BY id').all(teamId);
    const events = db.prepare(`SELECT e.id, a.role_name, e.kind, e.name, substr(e.body, 1, 1500) body, e.created_at FROM agent_events e LEFT JOIN agents a ON a.id = e.agent_id
      WHERE e.team_id = ? ORDER BY e.id DESC LIMIT 1500`).all(teamId).reverse();
    return { team: team ?? null, messages, summaries, events };
  }

  viewPo(id: string): unknown[] {
    return this.vdb(id).prepare('SELECT id, role, body, created_at FROM po_chat ORDER BY id DESC LIMIT 1000').all().reverse();
  }

  /* ---------- 복구 ---------- */
  /** 직전 상태를 백업하고, 고른 백업을 restore-pending 에 풀어 둔 뒤 서버를 다시 띄운다(시작할 때 바꿔 끼움) */
  async restore(targetId: string, name: string): Promise<{ restarting: boolean; before: BackupRunResult }> {
    const before = await this.backupNow('before-restore');
    if (!before.results.some((r) => r.ok)) throw new Error(`복구 전에 지금 상태를 백업하지 못해 멈췄습니다: ${before.error ?? before.results.map((r) => r.error).join(' · ')}`);
    const pending = join(this.deps.cfg.home, 'restore-pending');
    await this.fetchAndExtract(targetId, name, pending);
    writeFileSync(join(pending, 'RESTORE'), JSON.stringify({ name, target: targetId, at: nowIso() }));
    log.warn(`복구 준비 완료(${name}) → 서버를 다시 시작합니다`);
    const exit = this.deps.exit;
    if (exit) setTimeout(exit, 1500);
    return { restarting: !!exit, before };
  }

  /* ---------- 주기 ---------- */
  start(): void {
    const tick = () => {
      const cfg = this.config();
      const { lastDue } = scheduleTimes(cfg.schedule, new Date());
      if (!lastDue || this.running) return;
      const last = this.state().lastAttemptAt;
      if (!last || new Date(last) < lastDue) void this.backupNow('schedule');
    };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    setTimeout(tick, 30_000).unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); for (const k of [...this.views.keys()]) this.close(k); }
}

/**
 * 서버 시작 때(DB 를 열기 전) 풀어 둔 복구본이 있으면 바꿔 끼운다.
 * 지금 DB·이미지·패치는 restored-old-<시각> 폴더로 옮겨 둔다(직전 백업도 따로 있음).
 */
export function applyPendingRestore(cfg: AppConfig): string | null {
  const pending = join(cfg.home, 'restore-pending');
  if (!existsSync(join(pending, 'RESTORE')) || !existsSync(join(pending, 'hivelane.db'))) return null;
  const old = join(cfg.home, `restored-old-${stamp(new Date())}`);
  mkdirSync(old, { recursive: true });
  for (const f of ['hivelane.db', 'hivelane.db-wal', 'hivelane.db-shm']) if (existsSync(join(cfg.home, f))) renameSync(join(cfg.home, f), join(old, f));
  renameSync(join(pending, 'hivelane.db'), cfg.dbPath);
  for (const [dir, name] of [[cfg.uploadsDir, 'uploads'], [join(cfg.home, 'archive'), 'archive']] as const) {
    if (!existsSync(join(pending, name))) continue;
    if (existsSync(dir)) renameSync(dir, join(old, name));
    renameSync(join(pending, name), dir);
  }
  const info = readFileSync(join(pending, 'RESTORE'), 'utf8');
  rmSync(pending, { recursive: true, force: true });
  // 오래된 restored-old 는 3개만 남긴다
  const olds = readdirSync(cfg.home).filter((n) => n.startsWith('restored-old-')).sort().reverse();
  for (const n of olds.slice(3)) rmSync(join(cfg.home, n), { recursive: true, force: true });
  return info;
}
