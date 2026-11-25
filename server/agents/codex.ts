/**
 * Codex(OpenAI) 계정·실행.
 * - 계정마다 CODEX_HOME 폴더를 따로 둔다(로그인·대화 기록이 그 안에 있음). 이 맥 기본은 ~/.codex.
 * - 로그인: `codex login --device-auth`(링크 + 일회용 코드) 또는 API 키(`codex login --with-api-key`).
 * - 사용량: `codex app-server` 의 account/rateLimits/read(5시간·주간 %).
 * - 실행: @openai/codex-sdk 로 한 턴. 역할 도구에 따라 샌드박스(read-only / workspace-write)·작업 폴더를 제한하고 네트워크는 끈다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import type { AuthLoginView, LoginInfo, ToolPreset, UsageView, UsageWindow } from '../../shared/types.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';
import { truncate } from '../util.ts';
import { stripAnsi } from '../po/auth.ts';
import type { TurnHandle, TurnResult, TurnSpec } from './runner.ts';

const log = logger('codex');

/** 설치된 codex CLI(js 진입점). node 로 띄운다. 없으면 null */
export function codexJs(): string | null {
  try {
    const p = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    return existsSync(p) ? p : null;
  } catch { return null; }
}

function cliEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env, NO_COLOR: '1' };
}

function spawnCodex(args: string[], env?: Record<string, string>): ChildProcess {
  const js = codexJs();
  if (!js) throw new Error('Codex 가 설치돼 있지 않습니다(npm install 로 @openai/codex-sdk 설치)');
  return spawn(process.execPath, [js, ...args], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv(env) });
}

/** codex app-server 에 JSON-RPC 몇 개를 보내고 답을 모은다. */
async function appServer(env: Record<string, string> | undefined, calls: { method: string; params?: unknown }[], timeoutMs = 20_000): Promise<Record<string, { result?: unknown; error?: { message?: string } }>> {
  const p = spawnCodex(['app-server'], env);
  const out: Record<string, { result?: unknown; error?: { message?: string } }> = {};
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = () => { clearTimeout(t); p.kill(); resolve(out); };
    const t = setTimeout(() => { p.kill(); Object.keys(out).length ? resolve(out) : reject(new Error('Codex 응답이 없습니다')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: number; result?: unknown; error?: { message?: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 0) {
          p.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
          calls.forEach((c, k) => p.stdin!.write(JSON.stringify({ id: k + 1, method: c.method, params: c.params }) + '\n'));
        } else if (typeof m.id === 'number' && calls[m.id - 1]) {
          out[calls[m.id - 1]!.method] = { result: m.result, error: m.error };
          if (Object.keys(out).length === calls.length) done();
        }
      }
    });
    p.stdin!.write(JSON.stringify({ id: 0, method: 'initialize', params: { clientInfo: { name: 'hivelane', version: '0.1.0' } } }) + '\n');
  });
}

type RlWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number | null } | null | undefined;
type RlRead = { rateLimits?: { primary?: RlWindow; secondary?: RlWindow; planType?: string | null } };
type AcctRead = { account?: { type?: string; email?: string | null; planType?: string | null } | null };

function windowLabel(mins: number | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins <= 360) return `${Math.round(mins / 60)}시간`;
  if (mins >= 10_000) return '주간';
  return `${Math.round(mins / 1440)}일`;
}

/** app-server 답 → 화면 사용량(테스트용으로 따로 둔다) */
export function codexUsageView(rl: RlRead | undefined, acct: AcctRead | undefined, error: string | null): UsageView {
  const a = acct?.account ?? null;
  const login: LoginInfo = { loggedIn: !!a, method: a?.type === 'apiKey' ? 'API 키' : a?.type ?? null, expiresAt: null, email: a?.email ?? null };
  const windows: UsageWindow[] = [];
  const add = (key: string, w: RlWindow, fb: string) => {
    if (w && typeof w.usedPercent === 'number') windows.push({ key, label: windowLabel(w.windowDurationMins, fb), pct: w.usedPercent, resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null });
  };
  add('primary', rl?.rateLimits?.primary, '5시간');
  add('secondary', rl?.rateLimits?.secondary, '주간');
  return { available: windows.length > 0, plan: rl?.rateLimits?.planType ?? a?.planType ?? null, windows, takenAt: new Date().toISOString(), error, login };
}

/** Codex 계정 사용량(PlanUsage 와 같은 모양: last · refresh) */
export class CodexUsage {
  last: UsageView = { available: false, plan: null, windows: [], takenAt: null, error: null };
  private running: Promise<void> | null = null;
  constructor(private opts: { env?: Record<string, string>; onChange: () => void }) {}

  refresh(): Promise<void> {
    this.running ??= (async () => {
      try {
        const r = await appServer(this.opts.env, [{ method: 'account/read', params: {} }, { method: 'account/rateLimits/read' }]);
        const acct = r['account/read']?.result as AcctRead | undefined;
        const rl = r['account/rateLimits/read']?.result as RlRead | undefined;
        this.last = codexUsageView(rl, acct, null);
      } catch (e) {
        this.last = { ...this.last, takenAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e), login: this.last.login ?? { loggedIn: false, method: null, expiresAt: null, email: null } };
      } finally {
        this.running = null;
        this.opts.onChange();
      }
    })();
    return this.running;
  }
}

/** 기기 코드 로그인 출력에서 일회용 코드(예: 1BNE-8VFV2) */
export function findDeviceCode(out: string): string | null {
  const m = stripAnsi(out).match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/);
  return m ? m[1]! : null;
}

/** `codex login --device-auth` 을 대신 띄워 링크와 일회용 코드를 보여 준다(AuthLogin 과 같은 모양). */
export class CodexLogin {
  view: AuthLoginView = { phase: 'idle', url: null, output: '', startedAt: null, error: null };
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private opts: { env?: Record<string, string>; onDone: () => void }) {}

  start(): AuthLoginView {
    if (this.child) return this.view;
    const child = spawnCodex(['login', '--device-auth'], this.opts.env);
    this.child = child;
    this.view = { phase: 'waiting', url: null, output: '', startedAt: new Date().toISOString(), error: null, userCode: null };
    const add = (b: Buffer) => {
      this.view.output = (this.view.output + stripAnsi(b.toString())).slice(-4000);
      this.view.url ??= stripAnsi(this.view.output).match(/https:\/\/\S+/)?.[0] ?? null;
      this.view.userCode ??= findDeviceCode(this.view.output);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    child.on('error', (e) => this.finish('failed', e.message));
    child.on('exit', (code) => this.finish(code === 0 ? 'done' : 'failed', code === 0 ? null : `로그인이 끝나지 않았습니다(종료 코드 ${code ?? '신호'})`));
    this.timer = setTimeout(() => this.cancel('15분 안에 끝나지 않아 멈췄습니다'), 900_000);
    return this.view;
  }

  /** Codex 는 코드를 붙여 넣지 않는다(브라우저에 일회용 코드를 넣음). API 키 로그인은 apiKey() */
  code(): AuthLoginView { throw new Error('Codex 로그인은 브라우저에 일회용 코드를 넣습니다. API 키는 「API 키로 로그인」을 쓰세요'); }

  async apiKey(key: string): Promise<AuthLoginView> {
    this.cancel('API 키로 로그인합니다');
    const p = spawnCodex(['login', '--with-api-key'], this.opts.env);
    const out: string[] = [];
    p.stdout?.on('data', (b: Buffer) => out.push(b.toString()));
    p.stderr?.on('data', (b: Buffer) => out.push(b.toString()));
    p.stdin!.end(`${key.trim()}\n`);
    const code = await new Promise<number | null>((r) => { p.on('exit', r); p.on('error', () => r(-1)); });
    this.view = { phase: code === 0 ? 'done' : 'failed', url: null, output: truncate(stripAnsi(out.join('')), 2000), startedAt: new Date().toISOString(), error: code === 0 ? null : 'API 키 로그인에 실패했습니다' };
    this.opts.onDone();
    return this.view;
  }

  cancel(reason = '취소했습니다'): AuthLoginView {
    if (this.child) { this.child.kill('SIGTERM'); this.finish('failed', reason); }
    return this.view;
  }

  private finish(phase: 'done' | 'failed', error: string | null): void {
    if (!this.child) return;
    this.child = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.view = { ...this.view, phase, error };
    this.opts.onDone();
  }
}

/** 역할 도구 → Codex 샌드박스. 읽기는 read-only, 검증·쓰기는 작업 폴더만 쓰기 가능(네트워크 끔) */
export function codexSandbox(tools: ToolPreset): 'read-only' | 'workspace-write' {
  return tools === 'read' || tools === 'pm' ? 'read-only' : 'workspace-write';
}

const SANDBOX_NOTE: Record<'read-only' | 'workspace-write', string> = {
  'read-only': '이 실행은 읽기 전용 샌드박스다. 파일을 고치지 말고 읽고 조사해 결과만 답한다.',
  'workspace-write': '이 실행은 작업 폴더 안에서만 쓸 수 있는 샌드박스다(네트워크 없음). 작업 폴더 밖은 고치지 않는다.',
};

export interface CodexTurnSpec extends TurnSpec { toolPreset: ToolPreset }

/** Codex 한 턴. 진행(명령·파일 변경·답)은 Claude 턴과 같은 기록(agent events·runs)으로 남긴다. */
export async function runCodexTurn(store: Store, spec: CodexTurnSpec, handle: TurnHandle): Promise<TurnResult> {
  const teamId = spec.team?.id ?? null;
  const agentId = spec.agent.id;
  const result: TurnResult = { ok: false, subtype: 'unknown', text: '', costUsd: 0, sessionId: spec.resume ?? null, interrupted: false, error: null, contextTokens: 0 };
  const sandbox = codexSandbox(spec.toolPreset);
  const verifyNote = spec.toolPreset === 'verify' ? '\n검증 역할이다. 테스트·검사를 돌리고 결과를 보고하되 소스 파일은 고치지 않는다.' : '';
  const prompt = spec.resume ? spec.prompt : `${spec.systemAppend}\n\n${SANDBOX_NOTE[sandbox]}${verifyNote}\n\n---\n\n${spec.prompt}`;
  store.updateAgent(agentId, { state: 'busy', current_step: 'Codex 생각 중' });
  handle.codex = true;
  try {
    const { Codex } = await import('@openai/codex-sdk');
    const codex = new Codex({ env: { ...(process.env as Record<string, string>), ...spec.env } });
    const extra = (spec.writableRoots ?? []).filter((d) => d !== spec.cwd);
    const opts = {
      workingDirectory: spec.cwd, sandboxMode: sandbox, approvalPolicy: 'never' as const, skipGitRepoCheck: true,
      networkAccessEnabled: false, webSearchMode: 'disabled' as const,
      additionalDirectories: sandbox === 'workspace-write' && extra.length ? extra : undefined,
    };
    const thread = spec.resume ? codex.resumeThread(spec.resume, opts) : codex.startThread(opts);
    const { events } = await thread.runStreamed(prompt, { signal: handle.abort.signal });
    for await (const ev of events) {
      if (ev.type === 'thread.started') { result.sessionId = ev.thread_id; store.updateAgent(agentId, { session_id: ev.thread_id }); continue; }
      if (ev.type === 'turn.completed') {
        result.ok = true; result.subtype = 'success';
        const u = ev.usage;
        result.contextTokens = u.input_tokens;
        store.addAgentUsage(agentId, { cost: 0, inTok: u.input_tokens, outTok: u.output_tokens, context: u.input_tokens });
        continue;
      }
      if (ev.type === 'turn.failed') { result.subtype = 'error'; result.error = ev.error.message; continue; }
      if (ev.type === 'error') { result.subtype = 'error'; result.error = ev.message; continue; }
      if (ev.type !== 'item.started' && ev.type !== 'item.completed') continue;
      const it = ev.item;
      if (it.type === 'command_execution') {
        if (ev.type === 'item.started') {
          store.startRun({ agent_id: agentId, team_id: teamId, tool_use_id: it.id, tool: 'Bash', command: truncate(it.command, 2000) });
          store.addAgentEvent({ agent_id: agentId, team_id: teamId, kind: 'tool_use', name: 'Bash', body: `명령 실행\n$ ${truncate(it.command, 1500)}` });
          store.updateAgent(agentId, { current_step: `명령: ${truncate(it.command, 60)}` });
        } else {
          const bad = it.status === 'failed' || (it.exit_code ?? 0) !== 0;
          store.endRun(it.id, bad ? 'error' : 'ok');
          store.addAgentEvent({ agent_id: agentId, team_id: teamId, kind: bad ? 'tool_error' : 'tool_result', body: truncate(it.aggregated_output || `(종료 코드 ${it.exit_code ?? '-'})`, 2000) });
        }
      } else if (it.type === 'file_change' && ev.type === 'item.completed') {
        store.addAgentEvent({ agent_id: agentId, team_id: teamId, kind: it.status === 'failed' ? 'tool_error' : 'tool_use', name: 'Edit', body: `파일 ${it.status === 'failed' ? '변경 실패' : '변경'}: ${it.changes.map((c) => `${c.kind} ${c.path}`).join(', ')}` });
      } else if (it.type === 'agent_message' && ev.type === 'item.completed' && it.text.trim()) {
        store.addAgentEvent({ agent_id: agentId, team_id: teamId, kind: 'text', body: it.text });
        result.text = it.text;
      } else if (it.type === 'reasoning' && ev.type === 'item.completed' && it.text.trim()) {
        store.addAgentEvent({ agent_id: agentId, team_id: teamId, kind: 'think', body: truncate(it.text, 2000) });
      } else if (it.type === 'error' && ev.type === 'item.completed') {
        store.addAgentEvent({ agent_id: agentId, team_id: teamId, kind: 'tool_error', body: truncate(it.message, 1000) });
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.subtype = handle.interrupted ? 'interrupted' : 'exception';
    log.warn(`Codex 턴 예외 (${spec.agent.role_key}${teamId ? ' · ' + teamId : ''})`, result.error);
  } finally {
    handle.done = true;
    handle.releaseAll();
  }
  result.interrupted = handle.interrupted;
  store.addAgentEvent({ agent_id: agentId, team_id: teamId, kind: 'result', body: `${result.ok ? '턴 완료' : result.error ?? result.subtype} · Codex` });
  store.updateAgent(agentId, { state: handle.pauseRequested ? 'stop' : 'idle', current_step: handle.pauseRequested ? '일시정지' : result.ok ? '턴 완료' : '대기' });
  if (result.sessionId) store.updateAgent(agentId, { session_id: result.sessionId });
  return result;
}
