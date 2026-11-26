/**
 * 새 버전 내기 — 원본 저장소(main, 깨끗한 상태)에서:
 *   npm run release -- 1.1.0          # 버전 올림 → 커밋·태그 → 푸시 → DMG 만들기 → GitHub Releases 에 DMG 올리기
 *   npm run release -- 1.1.0 --dry    # 무엇을 할지만 보여 줌
 * 미리 CHANGELOG.md 맨 위에 「## 1.1.0 — 날짜」 단락을 써 둔다(그 내용이 릴리스 설명이 된다).
 * GitHub CLI(gh)에 저장소 주인 계정으로 로그인돼 있어야 한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpCask } from './cask.ts';

const ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) ?? '';
const dry = args.includes('--dry');
const sh = (cmd: string, a: string[], opts: { show?: boolean } = {}) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  if (dry && !opts.show) return '';
  return execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
};
const fail = (m: string) => { console.error(`✗ ${m}`); process.exit(1); };

if (!version) fail('버전을 적으세요. 예: npm run release -- 1.1.0');
const tag = `v${version}`;
const notes = (() => {
  const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const m = log.match(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
  return m?.[1]?.trim() ?? null;
})();
if (!notes) fail(`CHANGELOG.md 에 「## ${version} — 날짜」 단락이 없습니다. 먼저 써 주세요.`);
if (sh('git', ['status', '--porcelain'], { show: true })) fail('커밋 안 한 변경이 있습니다. 정리한 뒤 다시 하세요.');
if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { show: true }) !== 'main') fail('main 브랜치에서 하세요.');
sh('git', ['fetch', 'origin'], { show: true });
if (sh('git', ['rev-parse', 'HEAD'], { show: true }) !== sh('git', ['rev-parse', 'origin/main'], { show: true })) fail('origin/main 과 다릅니다. git pull 하세요.');
if (sh('git', ['tag', '-l', tag], { show: true })) fail(`${tag} 태그가 이미 있습니다.`);

// 1) 버전 올리기 → 커밋·태그·푸시
const cur = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
if (cur !== version) { // 이미 그 버전으로 올려 둔 커밋이면 건너뛴다
  sh('npm', ['version', version, '--no-git-tag-version']);
  sh('git', ['commit', '-am', `🔖 Release ${tag}`]);
}
sh('git', ['tag', '-a', tag, '-m', `Hivelane ${tag}`]);
sh('git', ['push', 'origin', 'main', tag]);

// 2) DMG
sh('npm', ['run', 'dist:mac']);
const dmg = join(ROOT, 'dist', 'desktop', `Hivelane-${version}-arm64.dmg`);
if (!dry && !existsSync(dmg)) fail(`DMG 가 없습니다: ${dmg}`);

// 3) GitHub Releases
const notesFile = join(tmpdir(), `hivelane-${tag}.md`);
writeFileSync(notesFile, `${notes}\n\n---\n설치: DMG 를 열어 Hivelane 을 응용 프로그램 폴더로 옮기고, 처음 열 때 「그래도 열기」를 한 번 누르세요. 자세한 내용은 [맥 앱 가이드](https://github.com/webjihong/hivelane/blob/${tag}/docs/MAC_APP.md).\n`);
sh('gh', ['release', 'create', tag, dmg, '--title', `Hivelane ${tag}`, '--notes-file', notesFile, '--latest']);

// 4) Homebrew cask(Casks/hivelane.rb) 를 새 버전·sha256 으로 → brew upgrade --cask hivelane 로 받을 수 있게
if (!dry) {
  const sha = execFileSync('shasum', ['-a', '256', dmg], { encoding: 'utf8' }).split(' ')[0]!;
  const caskPath = join(ROOT, 'Casks', 'hivelane.rb');
  writeFileSync(caskPath, bumpCask(readFileSync(caskPath, 'utf8'), version, sha));
}
sh('git', ['commit', '-am', `🍺 Homebrew cask ${tag}`]);
sh('git', ['push', 'origin', 'main']);
console.log(`✓ ${tag} 릴리스 완료 → https://github.com/webjihong/hivelane/releases/tag/${tag}`);

