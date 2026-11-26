/** 앱 버전(package.json). 소스 실행(server/)과 묶은 실행(dist/server/) 둘 다에서 찾는다. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function find(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      try { const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string }; if (j.version && j.name?.includes('hivelane')) return j.version; } catch { /* 다음 */ }
    }
    dir = dirname(dir);
  }
  return '0.0.0';
}

export const VERSION = find();
