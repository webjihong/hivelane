import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

let logFile: string | null = null;
let quiet = false;

export function initLog(logsDir: string | null, opts: { quiet?: boolean } = {}): void {
  logFile = logsDir ? join(logsDir, 'server.log') : null;
  quiet = opts.quiet ?? false;
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra === undefined ? '' : ' ' + safe(extra)}`;
  if (!quiet || level === 'error') (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  if (logFile) {
    try { appendFileSync(logFile, line + '\n'); } catch { /* 로그 실패로 서버를 멈추지 않는다 */ }
  }
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => { if (process.env.HIVELANE_DEBUG) write('debug', scope, m, e); },
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e),
  };
}
