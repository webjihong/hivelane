import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** 사람이 읽기 쉬운 짧은 id: 접두어 + 시간 + 난수 (예: t-mk3x9a2f) */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).slice(-5);
  const r = randomBytes(3).toString('hex').slice(0, 4);
  return `${prefix}-${t}${r}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface ExecResult { code: number; stdout: string; stderr: string }

/** 쉘을 거치지 않고 명령 실행. 실패해도 throw 하지 않고 code 로 돌려준다. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, env: opts.env ?? process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && !stderr ? err.message : '') });
    });
  });
}

/** 쉘 명령(점검 스크립트용). */
export function runShell(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return run('/bin/zsh', ['-lc', command], opts);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** 공백·대소문자 무시 glob 비슷한 패턴: 정규식 문자열이면 그대로, 아니면 부분 문자열 */
export function matchesAny(text: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (!p.trim()) continue;
    try {
      if (new RegExp(p, 'i').test(text)) return p;
    } catch {
      if (text.toLowerCase().includes(p.toLowerCase())) return p;
    }
  }
  return null;
}
