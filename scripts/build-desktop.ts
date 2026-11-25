/**
 * 맥 앱(DMG) 만들기 — npm run dist:mac
 *  1) 화면 빌드 + 서버 묶기
 *  2) desktop/.stage 에 앱 폴더를 따로 만들고 실행용 패키지만 설치한다.
 *     저장소의 node_modules 는 건드리지 않는다(개발 서버가 쓰는 네이티브 모듈을 Electron 용으로 바꾸지 않기 위해).
 *  3) electron-builder 가 .stage 의 네이티브 모듈을 Electron 용으로 다시 빌드하고 서명 없는 DMG(arm64)를 만든다.
 * 결과: (원본 저장소)/dist/desktop/Hivelane-<버전>-arm64.dmg — 팀 작업 폴더(worktree)에서 만들어도 원본 쪽에
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const STAGE = join(ROOT, 'desktop', '.stage');
/**
 * 결과 DMG 는 항상 원본 저장소의 dist/desktop 에 둔다.
 * 팀 작업 폴더(git worktree)에서 만들어도 원본 쪽에 모여야 찾기 쉽고, 작업 폴더를 정리할 때 같이 지워지지 않는다.
 */
function mainRepoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' });
  const common = r.status === 0 ? r.stdout.trim() : '';
  return common.endsWith('/.git') ? dirname(common) : ROOT;
}
const OUT = join(mainRepoRoot(), 'dist', 'desktop');
const require = createRequire(import.meta.url);

function run(cmd: string, args: string[], cwd = ROOT): void {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} 실패 (${r.status})`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string>; description: string };
const electronVersion = (require('electron/package.json') as { version: string }).version;

console.log('1) 화면 빌드 · 서버 묶기');
run('npm', ['run', 'build']);
run('npm', ['run', 'build:server']);

console.log('2) 앱 폴더 준비(desktop/.stage)');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const f of ['main.mjs', 'preload.cjs', 'setup.html', 'setup.js', 'trayTemplate.png', 'trayTemplate@2x.png']) cpSync(join(ROOT, 'desktop', f), join(STAGE, f));
cpSync(join(ROOT, 'dist', 'web'), join(STAGE, 'dist', 'web'), { recursive: true });
cpSync(join(ROOT, 'dist', 'server'), join(STAGE, 'dist', 'server'), { recursive: true });
writeFileSync(join(STAGE, 'package.json'), JSON.stringify({
  name: 'hivelane',
  productName: 'Hivelane',
  version: pkg.version,
  description: pkg.description,
  author: 'webjihong',
  type: 'module',
  main: 'main.mjs',
  dependencies: pkg.dependencies,
}, null, 2));
// .stage 는 저장소 node_modules 와 따로 노는 폴더다(실행용 패키지만)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], STAGE);

console.log('3) DMG 만들기(서명 없음)');
// electron-builder 는 개발용 의존성(설치 후에만 있다)이라 타입 없이 불러온다
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { build, Platform, Arch } = require('electron-builder') as any;
await build({
  targets: Platform.MAC.createTarget(['dmg'], Arch.arm64),
  config: {
    appId: 'com.webjihong.hivelane.desktop',
    productName: 'Hivelane',
    electronVersion,
    asar: false,
    npmRebuild: true,
    directories: { app: STAGE, output: OUT },
    files: ['**/*'],
    mac: {
      icon: join(ROOT, 'web', 'public', 'icon-512.png'),
      category: 'public.app-category.developer-tools',
      identity: null, // 서명 없음(받는 사람은 설정 › 개인정보 보호 및 보안 › 「그래도 열기」)
      extendInfo: { LSUIElement: false },
    },
    dmg: { title: 'Hivelane ${version}' },
  },
});
console.log(`완료: ${OUT}`);
