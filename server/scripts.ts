import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { bus } from './bus.ts';
import { logger } from './log.ts';
import { st } from './i18n.ts';
import type { Store } from './store.ts';
import { newId, nowIso } from './util.ts';
import type { ScriptRunView, ScriptView } from '../shared/types.ts';

const log = logger('scripts');
/** 저장하는 출력 상한(뒷부분을 남긴다) */
const MAX_OUT = 400_000;
const TIMEOUT_MS = 60 * 60_000;
/** 스크립트로도 막는 것: 비밀번호를 기다리며 멈추거나 되돌릴 수 없는 것 */
const HARD_BLOCK = [/\bsudo\b/, /\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/];

interface Row { id: string; project_id: string | null; name: string; command: string; cwd: string; confirm: number; sort: number; created_at: string }
interface RunRow { id: number; script_id: string; command: string; cwd: string; started_at: string; finished_at: string | null; exit_code: number | null; by: 'local' | 'remote'; output: string }

/** 등록한 명령을 맥에서 돌리고 출력을 화면으로 흘려보낸다. 한 스크립트는 한 번에 하나만. */
export class ScriptRunner {
  private live = new Map<number, { child: ChildProcess; out: string; scriptId: string; pending: string; timer: NodeJS.Timeout | null }>();

  constructor(private store: Store) {
    // 서버가 꺼질 때 돌던 실행은 중단으로 마감
    store.db.prepare("UPDATE script_runs SET finished_at = ?, exit_code = -1, output = output || ? WHERE finished_at IS NULL").run(nowIso(), `\n${st('[서버 재시작으로 중단됨]')}`);
  }

  private get db() { return this.store.db; }

  list(): ScriptView[] {
    const rows = this.db.prepare('SELECT * FROM scripts ORDER BY project_id, sort, created_at').all() as Row[];
    return rows.map((r) => this.view(r));
  }
  private view(r: Row): ScriptView {
    const last = this.db.prepare('SELECT id, script_id, command, cwd, started_at, finished_at, exit_code, by FROM script_runs WHERE script_id = ? ORDER BY id DESC LIMIT 1').get(r.id) as ScriptRunView | undefined;
    const running = [...this.live.entries()].find(([, v]) => v.scriptId === r.id)?.[0] ?? null;
    return { id: r.id, project_id: r.project_id, project_name: this.store.getProject(r.project_id)?.name ?? null, name: r.name, command: r.command, cwd: r.cwd, confirm: !!r.confirm, running_run_id: running, last_run: last ?? null };
  }
  get(id: string): Row | null { return (this.db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as Row | undefined) ?? null; }

  save(s: { id?: string; project_id: string | null; name: string; command: string; cwd?: string; confirm?: boolean }): ScriptView {
    if (s.id && this.get(s.id)) {
      this.db.prepare('UPDATE scripts SET project_id = ?, name = ?, command = ?, cwd = ?, confirm = ? WHERE id = ?').run(s.project_id, s.name, s.command, s.cwd ?? '', s.confirm ? 1 : 0, s.id);
    } else {
      const sort = (this.db.prepare('SELECT coalesce(max(sort), 0) + 1 n FROM scripts').get() as { n: number }).n;
      s.id = newId('sc');
      this.db.prepare('INSERT INTO scripts (id, project_id, name, command, cwd, confirm, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, s.project_id, s.name, s.command, s.cwd ?? '', s.confirm ? 1 : 0, sort, nowIso());
    }
    bus.changed('scripts');
    return this.view(this.get(s.id)!);
  }
  remove(id: string): boolean {
    if ([...this.live.values()].some((v) => v.scriptId === id)) throw new Error(st('돌고 있는 스크립트는 지울 수 없습니다'));
    const r = this.db.prepare('DELETE FROM scripts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM script_runs WHERE script_id = ?').run(id);
    bus.changed('scripts');
    return r.changes > 0;
  }

  /** 실행 폴더: 비우면 프로젝트 폴더, 상대 경로면 프로젝트 기준. 프로젝트 밖은 프로젝트 없는 스크립트만 */
  cwdOf(r: Row): string {
    const base = this.store.getProject(r.project_id)?.path ?? homedir();
    if (!r.cwd) return base;
    const expanded = r.cwd.replace(/^~(?=\/|$)/, homedir());
    const abs = isAbsolute(expanded) ? expanded : join(base, expanded);
    if (r.project_id && relative(base, abs).startsWith('..')) throw new Error(st('실행 폴더가 프로젝트 밖입니다'));
    return abs;
  }

  run(id: string, by: 'local' | 'remote'): number {
    const r = this.get(id);
    if (!r) throw new Error(st('없는 스크립트입니다'));
    if ([...this.live.values()].some((v) => v.scriptId === id)) throw new Error(st('이미 돌고 있습니다'));
    const bad = HARD_BLOCK.find((re) => re.test(r.command));
    if (bad) throw new Error(st('막힌 명령입니다({rule}) · 터미널에서 직접 실행하세요', { rule: bad.source }));
    const cwd = this.cwdOf(r);
    if (!existsSync(cwd)) throw new Error(st('실행 폴더가 없습니다: {cwd}', { cwd }));
    const runId = Number(this.db.prepare('INSERT INTO script_runs (script_id, command, cwd, started_at, by) VALUES (?, ?, ?, ?, ?)').run(id, r.command, cwd, nowIso(), by).lastInsertRowid);
    const child = spawn('/bin/zsh', ['-lc', r.command], { cwd, detached: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lv = { child, out: '', scriptId: id, pending: '', timer: null as NodeJS.Timeout | null };
    this.live.set(runId, lv);
    const flush = () => { lv.timer = null; if (lv.pending) { bus.emitEvent({ type: 'script_out', runId, chunk: lv.pending }); lv.pending = ''; } };
    const onData = (b: Buffer) => {
      // eslint-disable-next-line no-control-regex -- 색 코드 제거
      const t = b.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      lv.out += t; if (lv.out.length > MAX_OUT) lv.out = lv.out.slice(-MAX_OUT);
      lv.pending += t;
      if (!lv.timer) lv.timer = setTimeout(flush, 150);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const kill = setTimeout(() => { onData(Buffer.from(`\n${st('[1시간이 지나 멈춤]')}\n`)); this.stop(runId); }, TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(kill);
      if (lv.timer) { clearTimeout(lv.timer); flush(); }
      const exit = code ?? (signal ? 130 : -1);
      this.db.prepare('UPDATE script_runs SET finished_at = ?, exit_code = ?, output = ? WHERE id = ?').run(nowIso(), exit, lv.out, runId);
      this.live.delete(runId);
      log.info(`스크립트 끝 ${r.name} → ${exit}`);
      bus.changed('scripts');
    });
    child.on('error', (e) => onData(Buffer.from(`\n${st('[실행 오류] {msg}', { msg: e.message })}\n`)));
    log.info(`스크립트 실행 ${r.name} (${by}) · ${cwd} · ${r.command.slice(0, 120)}`);
    bus.changed('scripts');
    return runId;
  }

  stop(runId: number): boolean {
    const cur = this.live.get(runId);
    if (!cur?.child.pid) return false;
    try { process.kill(-cur.child.pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
    setTimeout(() => { if (this.live.has(runId) && cur.child.pid) { try { process.kill(-cur.child.pid, 'SIGKILL'); } catch { /* 끝남 */ } } }, 5000);
    return true;
  }

  getRun(runId: number): ScriptRunView | null {
    const live = this.live.get(runId);
    const r = this.db.prepare('SELECT * FROM script_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!r) return null;
    return { ...r, output: live ? live.out : r.output };
  }
  runs(scriptId: string, limit = 10): ScriptRunView[] {
    return this.db.prepare('SELECT id, script_id, command, cwd, started_at, finished_at, exit_code, by FROM script_runs WHERE script_id = ? ORDER BY id DESC LIMIT ?').all(scriptId, limit) as ScriptRunView[];
  }

  /** 프로젝트의 package.json 스크립트(루트 + 한 단계 아래 폴더) — 버튼으로 바로 등록하려고 */
  npmScripts(projectPath: string): { dir: string; name: string; command: string }[] {
    const out: { dir: string; name: string; command: string }[] = [];
    const read = (dir: string) => {
      try {
        const pj = JSON.parse(readFileSync(join(projectPath, dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        for (const [name, cmd] of Object.entries(pj.scripts ?? {})) out.push({ dir, name, command: cmd });
      } catch { /* package.json 없음 */ }
    };
    read('');
    try { for (const d of readdirSync(projectPath, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && existsSync(join(projectPath, d.name, 'package.json'))) read(d.name); } catch { /* 읽기 실패 */ }
    return out.slice(0, 300);
  }
}
