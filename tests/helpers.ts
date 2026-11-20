import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ensureDirs, type AppConfig } from '../server/config.ts';
import { openDb } from '../server/db/index.ts';
import { initLog } from '../server/log.ts';
import { seedTemplates, Store } from '../server/store.ts';

initLog(null, { quiet: true });

export function tmp(prefix = 'hl-'): string { return mkdtempSync(join(tmpdir(), prefix)); }

export function testEnv(): { cfg: AppConfig; store: Store } {
  const home = tmp('hl-home-');
  const cfg = loadConfig({ HIVELANE_HOME: home } as NodeJS.ProcessEnv);
  ensureDirs(cfg);
  const store = new Store(openDb(cfg.dbPath));
  seedTemplates(store);
  return { cfg, store };
}

/** 작은 git 저장소: 하위 패키지 하나(node_modules 포함) + 원격 없이 main 브랜치 */
export function makeRepo(): string {
  const dir = tmp('hl-repo-');
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  execFileSync('mkdir', ['-p', join(dir, 'app', 'node_modules', 'dep')]);
  writeFileSync(join(dir, 'app', 'package.json'), '{"name":"app"}\n');
  writeFileSync(join(dir, 'app', 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, 'app', 'index.js'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  g('add', '.'); g('commit', '-q', '-m', 'init');
  return dir;
}
