/**
 * Hivelane 상시 실행 관리 (macOS launchd + Tailscale serve)
 *   npx tsx scripts/service.ts install [--tailscale]   빌드 → launchd 등록·시작 (→ tailscale serve)
 *   npx tsx scripts/service.ts uninstall [--tailscale] launchd 해제 (→ tailscale serve 끄기)
 *   npx tsx scripts/service.ts status                  상태
 *   npx tsx scripts/service.ts restart                 다시 시작
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../server/config.ts';

const LABEL = 'com.webjihong.hivelane';
const ROOT = join(import.meta.dirname, '..');
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const cfg = loadConfig();
const uid = userInfo().uid;
const domain = `gui/${uid}`;

function sh(cmd: string, args: string[], opts: { quiet?: boolean; allowFail?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} 실패\n${r.stderr || r.stdout}`);
  if (!opts.quiet && r.stdout.trim()) console.log(r.stdout.trim());
  return (r.stdout ?? '') + (r.stderr ?? '');
}

function tailscaleBin(): string | null {
  for (const p of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) if (existsSync(p)) return p;
  const w = spawnSync('which', ['tailscale'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}

/**
 * 로그인 항목에 「node」 대신 「Hivelane」(아이콘 포함)으로 보이게 하는 앱 껍데기.
 * ~/.hivelane/Hivelane.app/Contents/MacOS/Hivelane 가 node 서버를 exec 한다(pid 그대로라 launchd 가 그대로 관리).
 */
function appBundle(): string {
  const app = join(cfg.home, 'Hivelane.app');
  const node = process.execPath;
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>Hivelane</string>
  <key>CFBundleDisplayName</key><string>Hivelane</string>
  <key>CFBundleExecutable</key><string>Hivelane</string>
  <key>CFBundleIconFile</key><string>Hivelane</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`);
  const exe = join(app, 'Contents', 'MacOS', 'Hivelane');
  writeFileSync(exe, `#!/bin/sh\n# Hivelane 서버(launchd 가 띄움) — 로그인 항목에 Hivelane 으로 보이게 하는 껍데기\ncd ${q(ROOT)} && exec ${q(node)} --import ${q(tsx)} ${q(join(ROOT, 'server', 'index.ts'))}\n`, { mode: 0o755 });
  // 아이콘: web/public/icon-512.png → icns (실패해도 무시)
  const png = join(ROOT, 'web', 'public', 'icon-512.png');
  const icns = join(app, 'Contents', 'Resources', 'Hivelane.icns');
  if (existsSync(png)) {
    const set = join(cfg.home, 'Hivelane.iconset');
    rmSync(set, { recursive: true, force: true }); mkdirSync(set);
    for (const n of [16, 32, 128, 256, 512]) {
      sh('sips', ['-z', String(n), String(n), png, '--out', join(set, `icon_${n}x${n}.png`)], { quiet: true, allowFail: true });
      if (n <= 256) sh('sips', ['-z', String(n * 2), String(n * 2), png, '--out', join(set, `icon_${n}x${n}@2x.png`)], { quiet: true, allowFail: true });
    }
    sh('iconutil', ['-c', 'icns', set, '-o', icns], { quiet: true, allowFail: true });
    rmSync(set, { recursive: true, force: true });
  }
  return exe;
}

function plist(exe: string): string {
  const node = process.execPath;
  const path = [dirname(node), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(exe)}</string>
  </array>
  <key>AssociatedBundleIdentifiers</key><string>${LABEL}</string>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>${esc(path)}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
    <key>HIVELANE_HOME</key><string>${esc(cfg.home)}</string>
    <key>HIVELANE_PORT</key><string>${cfg.port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(join(cfg.logsDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(cfg.logsDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

async function waitHealthy(ms = 20000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const r = await fetch(`http://127.0.0.1:${cfg.port}/api/health`); if (r.ok) return true; } catch { /* 아직 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function install(withTs: boolean) {
  console.log('1) 화면 빌드');
  sh('npm', ['run', 'build'], { quiet: true });
  mkdirSync(cfg.logsDir, { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  console.log(`2) launchd 등록: ${PLIST}`);
  sh('launchctl', ['bootout', `${domain}/${LABEL}`], { quiet: true, allowFail: true });
  const exe = appBundle();
  writeFileSync(PLIST, plist(exe));
  // 방금 내린 서비스가 완전히 빠지기 전이면 bootstrap 이 「Input/output error」로 실패한다 → 잠깐 기다리며 다시
  for (let i = 0; ; i++) {
    const r = spawnSync('launchctl', ['bootstrap', domain, PLIST], { encoding: 'utf8' });
    if (r.status === 0) break;
    if (i >= 9) throw new Error(`launchctl bootstrap 실패\n${r.stderr || r.stdout}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  sh('launchctl', ['enable', `${domain}/${LABEL}`], { allowFail: true });
  const ok = await waitHealthy();
  console.log(ok ? `   서버 응답 OK → http://127.0.0.1:${cfg.port}` : `   서버가 아직 응답하지 않습니다. 로그: ${cfg.logsDir}`);
  if (withTs) {
    const ts = tailscaleBin();
    if (!ts) { console.log('3) tailscale 명령을 찾지 못해 원격 설정을 건너뜁니다'); return; }
    console.log('3) tailscale serve (내 tailnet 안에서만, funnel 아님)');
    sh(ts, ['serve', '--bg', String(cfg.remotePort)]);
    const st = sh(ts, ['serve', 'status'], { quiet: true, allowFail: true });
    const url = st.match(/https:\/\/[^\s]+/)?.[0];
    if (url) console.log(`   휴대폰에서: ${url}  (설정 › 원격 접속에서 주인 계정 등록 필요)`);
  }
}

function uninstall(withTs: boolean) {
  sh('launchctl', ['bootout', `${domain}/${LABEL}`], { allowFail: true });
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log('launchd 해제 완료 (데이터는 그대로: ' + cfg.home + ')');
  if (withTs) { const ts = tailscaleBin(); if (ts) { sh(ts, ['serve', 'reset'], { allowFail: true }); console.log('tailscale serve 해제'); } }
}

function status() {
  const out = sh('launchctl', ['print', `${domain}/${LABEL}`], { quiet: true, allowFail: true });
  const state = out.match(/state = (\w+)/)?.[1] ?? '등록 안 됨';
  const pid = out.match(/pid = (\d+)/)?.[1];
  console.log(`launchd: ${state}${pid ? ` (pid ${pid})` : ''}`);
  const ts = tailscaleBin();
  if (ts) console.log('tailscale serve:\n' + sh(ts, ['serve', 'status'], { quiet: true, allowFail: true }).trim());
  try { execFileSync('curl', ['-sf', `http://127.0.0.1:${cfg.port}/api/health`]); console.log('서버 응답: OK'); } catch { console.log('서버 응답: 없음'); }
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
const withTs = rest.includes('--tailscale');
if (cmd === 'install') await install(withTs);
else if (cmd === 'uninstall') uninstall(withTs);
else if (cmd === 'restart') { sh('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]); console.log((await waitHealthy()) ? '다시 시작 OK' : '응답 없음'); }
else status();
