import { st } from '../i18n.ts';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuthLoginView, LoginInfo } from '../../shared/types.ts';
import { logger } from '../log.ts';

const log = logger('auth');

/** 팀이 쓰는 것과 같은 claude(SDK 에 들어 있는 것). 없으면 PATH 의 claude */
export function claudeBin(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const p = join(dirname(pkg), 'claude');
    if (existsSync(p)) return p;
  } catch { /* 없음 */ }
  return 'claude';
}

/** OSC 8 링크·ANSI 색 걷기 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\]8;;[^\u0007\u001b]*(\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** 로그인 출력에서 첫 https 주소 */
export function findUrl(out: string): string | null {
  const m = stripAnsi(out).match(/https:\/\/\S+/);
  return m ? m[0] : null;
}

export async function loginInfo(bin = claudeBin(), env?: Record<string, string>): Promise<LoginInfo> {
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status', '--json'], { timeout: 15_000, cwd: tmpdir(), env: { ...process.env, ...env } }, (err, stdout) => {
      try {
        const d = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; loginExpiresAt?: string; email?: string; subscriptionType?: string };
        resolve({ loggedIn: !!d.loggedIn, method: d.authMethod ?? null, expiresAt: d.loginExpiresAt ?? null, email: d.email ?? null });
      } catch {
        resolve({ loggedIn: false, method: null, expiresAt: null, email: null, error: err?.message ?? st('상태를 읽지 못했습니다') });
      }
    });
  });
}

/** `claude auth login` 을 대신 띄워 링크를 보여 주고, 코드 붙여넣기를 받아 넘긴다. 로그인 자체는 사용자가 브라우저에서 한다. */
export class AuthLogin {
  view: AuthLoginView = { phase: 'idle', url: null, output: '', startedAt: null, error: null };
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: { onDone: () => void; bin?: string; /** 계정별 로그인 폴더(CLAUDE_CONFIG_DIR) */ env?: Record<string, string> }) {}

  start(): AuthLoginView {
    if (this.child) return this.view;
    const child = spawn(this.opts.bin ?? claudeBin(), ['auth', 'login', '--claudeai'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.opts.env, NO_COLOR: '1' } });
    this.child = child;
    this.view = { phase: 'waiting', url: null, output: '', startedAt: new Date().toISOString(), error: null };
    const add = (b: Buffer) => {
      this.view.output = (this.view.output + stripAnsi(b.toString())).slice(-4000);
      this.view.url ??= findUrl(this.view.output);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    child.on('error', (e) => { this.finish('failed', e.message); });
    child.on('exit', (code) => { this.finish(code === 0 ? 'done' : 'failed', code === 0 ? null : st('로그인이 끝나지 않았습니다(종료 코드 {code})', { code: code ?? st('신호') })); });
    this.timer = setTimeout(() => { this.cancel(st('10분 안에 끝나지 않아 멈췄습니다')); }, 600_000);
    return this.view;
  }

  /** 브라우저가 보여 준 인증 코드를 붙여 넣기 */
  code(code: string): AuthLoginView {
    if (!this.child?.stdin?.writable) throw new Error(st('진행 중인 로그인이 없습니다'));
    this.child.stdin.write(`${code.trim()}\n`);
    return this.view;
  }

  cancel(reason = st('취소했습니다')): AuthLoginView {
    if (this.child) { this.child.kill('SIGTERM'); this.finish('failed', reason); }
    return this.view;
  }

  private finish(phase: 'done' | 'failed', error: string | null): void {
    if (!this.child) return;
    this.child = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.view = { ...this.view, phase, error };
    if (phase === 'done') log.info('Claude 재로그인 완료'); else log.warn('Claude 재로그인 실패', error);
    this.opts.onDone();
  }
}
