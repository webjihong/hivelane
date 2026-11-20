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
  host: string;
  port: number;
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
    host: env.HIVELANE_HOST ?? '127.0.0.1',
    port: Number(env.HIVELANE_PORT ?? 4310),
    webDist: join(import.meta.dirname, '..', 'dist', 'web'),
    production: env.NODE_ENV === 'production',
  };
}

export function ensureDirs(cfg: AppConfig): void {
  for (const d of [cfg.home, cfg.worktreesDir, cfg.poDir, cfg.standingDir, cfg.logsDir]) mkdirSync(d, { recursive: true });
}
