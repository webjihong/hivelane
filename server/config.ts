import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppConfig {
  home: string;
  dbPath: string;
  worktreesDir: string;
  poDir: string;
  standingDir: string;
  logsDir: string;
  /** 사람이 붙여 넣은 이미지 */
  uploadsDir: string;
  host: string;
  port: number;
  /** tailscale serve 가 넘겨주는 전용 포트. 여기로 들어온 요청은 항상 원격으로 본다. */
  remotePort: number;
  webDist: string;
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const home = env.HIVELANE_HOME ?? join(homedir(), '.hivelane');
  return {
    home,
    dbPath: join(home, 'hivelane.db'),
    worktreesDir: join(home, 'worktrees'),
    poDir: join(home, 'po'),
    standingDir: join(home, 'standing'),
    logsDir: join(home, 'logs'),
    uploadsDir: join(home, 'uploads'),
    host: env.HIVELANE_HOST ?? '127.0.0.1',
    port: Number(env.HIVELANE_PORT ?? 4310),
    remotePort: Number(env.HIVELANE_REMOTE_PORT ?? Number(env.HIVELANE_PORT ?? 4310) + 2),
    webDist: join(import.meta.dirname, '..', 'dist', 'web'),
    production: env.NODE_ENV === 'production',
  };
}

export function ensureDirs(cfg: AppConfig): void {
  for (const d of [cfg.home, cfg.worktreesDir, cfg.poDir, cfg.standingDir, cfg.logsDir, cfg.uploadsDir]) mkdirSync(d, { recursive: true });
}
