/**
 * 서버를 파일 하나(dist 아래 server/index.mjs)로 묶는다. 데스크톱 앱이 tsx 없이 그대로 실행한다.
 * 패키지(node_modules)는 묶지 않는다: better-sqlite3·sqlite-vec 같은 네이티브 모듈과 Claude 실행 파일이 있어서다.
 */
import { build } from 'esbuild';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
await build({
  entryPoints: [join(root, 'server', 'index.ts')],
  outfile: join(root, 'dist', 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'linked',
  logLevel: 'info',
});
