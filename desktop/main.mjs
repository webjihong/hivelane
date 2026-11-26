/**
 * Hivelane 맥 앱 (Electron)
 * - 서버는 앱 안의 Electron 을 Node 로 써서(ELECTRON_RUN_AS_NODE) launchd 로 상시 실행한다.
 *   앱 창을 닫거나 앱을 꺼도 팀은 계속 일하고, 휴대폰(Tailscale) 접속도 그대로다.
 * - 이미 다른 방식(개발용 npm run service:install)으로 서버가 떠 있으면 그 서버에 붙기만 한다.
 * - 서버가 없으면 처음 실행 안내 화면(setup.html)에서 점검 → 설치 → 시작.
 */
import { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, shell, dialog } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const LABEL = 'com.webjihong.hivelane';
/** 로그인 항목에 「Hivelane」(앱 아이콘)으로 보이게 서비스를 이 앱에 묶는다 — electron-builder appId 와 같아야 한다 */
const APP_ID = 'com.webjihong.hivelane.desktop';
const PORT = Number(process.env.HIVELANE_PORT ?? 4310);
const REMOTE_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = process.env.HIVELANE_HOME ?? join(homedir(), '.hivelane');
const LOGS = join(DATA, 'logs');
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${userInfo().uid}`;
/** 앱 폴더(패키지 안에서는 Resources/app). 개발 중(npm run desktop)에는 저장소 루트를 넘겨받는다 */
const ROOT = process.env.HIVELANE_APP_ROOT ?? app.getAppPath();
const SERVER = join(ROOT, 'dist', 'server', 'index.mjs');
const WEB = join(ROOT, 'dist', 'web');
const HERE = import.meta.dirname;

/** 앱 글 언어: HIVELANE_LANG(ko/en) 이 있으면 그것, 아니면 맥 언어(한국어가 아니면 영어) */
const LANG = (() => {
  const env = process.env.HIVELANE_LANG?.toLowerCase();
  if (env === 'ko' || env === 'en') return env;
  try { return app.getPreferredSystemLanguages()[0]?.toLowerCase().startsWith('ko') ? 'ko' : 'en'; } catch { return 'ko'; }
})();
/** 한국어 / 영어 중 앱 언어에 맞는 글 */
const L = (ko, en) => (LANG === 'ko' ? ko : en);

/** @type {BrowserWindow | null} */ let win = null;
/** @type {Tray | null} */ let tray = null;
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, env) => { const r = spawnSync(cmd, args, { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env }); return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }; };
/** Finder 에서 연 앱에는 터미널이 없어서, 앱용 Tailscale 실행 파일이 CLI 대신 GUI 로 뜨려 한다 → CLI 로 돌게 표시 */
const ts = (bin, args) => sh(bin, args, { TAILSCALE_BE_CLI: '1', TERM: process.env.TERM || 'xterm-256color' });
const tsUrl = (out) => out.match(/https:\/\/[^\s)]+/)?.[0] ?? null;

async function healthy() {
  try { const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
async function waitHealthy(ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await healthy()) return true; await sleep(500); }
  return false;
}

/* ---------- 상시 실행(launchd) ---------- */

/** 등록된 서비스가 누구 것인지: 'app'(이 앱) · 'other'(개발용 등 다른 방식) · null(없음) */
function serviceOwner() {
  if (!existsSync(PLIST)) return null;
  const xml = readFileSync(PLIST, 'utf8');
  return xml.includes(`<string>${esc(process.execPath)}</string>`) && xml.includes(esc(SERVER)) ? 'app' : 'other';
}
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function plist() {
  const path = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(SERVER)}</string>
  </array>
  <key>AssociatedBundleIdentifiers</key><string>${APP_ID}</string>
  <key>WorkingDirectory</key><string>${esc(DATA)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>${esc(path)}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
    <key>HIVELANE_HOME</key><string>${esc(DATA)}</string>
    <key>HIVELANE_PORT</key><string>${PORT}</string>
    <key>HIVELANE_WEB_DIST</key><string>${esc(WEB)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(join(LOGS, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(LOGS, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

async function installService() {
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  sh('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]);
  writeFileSync(PLIST, plist());
  // 방금 내린 서비스가 빠지기 전이면 bootstrap 이 실패한다 → 잠깐 기다리며 다시
  let last = '';
  for (let i = 0; i < 10; i++) {
    const r = sh('launchctl', ['bootstrap', DOMAIN, PLIST]);
    if (r.ok) { sh('launchctl', ['enable', `${DOMAIN}/${LABEL}`]); return { ok: await waitHealthy(), log: LOGS }; }
    last = r.out; await sleep(1000);
  }
  return { ok: false, error: L(`launchctl bootstrap 실패: ${last}`, `launchctl bootstrap failed: ${last}`), log: LOGS };
}

function uninstallService() {
  sh('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]);
  if (existsSync(PLIST)) rmSync(PLIST);
}

async function restartService() {
  sh('launchctl', ['kickstart', '-k', `${DOMAIN}/${LABEL}`]);
  return waitHealthy();
}

/* ---------- 점검 ---------- */

function tailscaleBin() {
  for (const p of ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']) if (existsSync(p)) return p;
  return null;
}

async function status() {
  const clt = sh('xcode-select', ['-p']).ok;
  const git = clt ? sh('git', ['--version']) : { ok: false, out: '' };
  const tbin = tailscaleBin();
  const serve = tbin ? ts(tbin, ['serve', 'status']) : { ok: false, out: '' };
  return {
    version: app.getVersion(),
    data: DATA,
    server: await healthy(),
    service: serviceOwner(),
    git: git.ok ? git.out.split('\n')[0] : null,
    tailscale: tbin ? (tsUrl(serve.out) ?? 'installed') : null,
  };
}

/* ---------- 창 ---------- */

function showSetup() {
  if (!win) createWindow();
  win.loadFile(join(HERE, 'setup.html'), { query: { lang: LANG } });
}
async function showApp() {
  if (!win) createWindow();
  await win.loadURL(`${BASE}/?app=desktop${process.env.HIVELANE_CAPTURE_HASH ?? '#home'}`);
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 500, title: 'Hivelane', backgroundColor: '#F1F4F6',
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // 바깥 링크(깃허브·PR 등)는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(BASE) && !url.startsWith('file:')) { e.preventDefault(); void shell.openExternal(url); } });
  // 창을 닫아도 앱(메뉴 막대)은 남는다. 서버는 launchd 가 따로 돌린다.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  win.on('closed', () => { win = null; });
}

async function openMain() {
  if (await healthy()) await showApp(); else showSetup();
  win?.show(); win?.focus();
}

/* ---------- 메뉴 막대 ---------- */

/** 서버 스냅샷에서 「일하는 팀」·「내가 확인할 것」을 센다(화면의 「지금 볼 것」과 같은 기준) */
async function teamSummary() {
  try {
    const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const snap = await r.json();
    const live = (snap.teams ?? []).filter((t) => t.state !== 'archived');
    const asks = (t) => !!t.question && ['waiting_human', 'idle', 'down', 'paused'].includes(t.state);
    const needTeams = live.filter((t) => asks(t) || ['waiting_human', 'failed', 'down'].includes(t.state));
    const proposals = (snap.proposals ?? []).filter((p) => p.status === 'pending').length;
    const working = live.filter((t) => ['running', 'queued', 'reviving'].includes(t.state));
    return { need: needTeams.length + proposals, needTeams, proposals, working, poBusy: !!snap.poBusy };
  } catch { return null; }
}

/** 창을 열고 화면 안의 특정 위치(#team-…, #po)로 간다 */
async function openAt(hash) {
  if (!(await healthy())) return openMain();
  if (!win) createWindow();
  const cur = win.webContents.getURL();
  if (cur.startsWith(BASE)) await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
  else await win.loadURL(`${BASE}/?app=desktop${hash}`);
  win.show(); win.focus();
}

/**
 * 메뉴 막대 아이콘(벌집): 일하는 중이면 꿀이 차는 칸이 돌고, 확인할 것이 있으면 오른쪽 위에 점, 꺼지면 흐린 점선.
 * 모든 그림이 같은 크기라 바꿔 끼워도 옆 아이콘이 움직이지 않는다(글자를 붙이면 폭이 바뀌어 흔들린다).
 */
const ICON = {};
function icon(name) {
  if (!ICON[name]) { const img = nativeImage.createFromPath(join(HERE, 'tray', `${name}Template.png`)); img.setTemplateImage(true); ICON[name] = img; }
  return ICON[name];
}
let frame = 0;
let shown = '';
let last = { up: false, sum: null };
function paintIcon() {
  if (!tray) return;
  const { up, sum } = last;
  const need = !!sum?.need;
  const working = !!sum && (sum.working.length > 0 || sum.poBusy);
  const name = !up ? 'off' : working ? `${need ? 'workattn' : 'work'}${frame = (frame + 1) % 3}` : need ? 'attn' : 'idle';
  if (name !== shown) { tray.setImage(icon(name)); shown = name; }
}
setInterval(paintIcon, 500);

async function refreshTray() {
  if (!tray) return;
  const up = await healthy();
  const sum = up ? await teamSummary() : null;
  last = { up, sum };
  paintIcon();
  const owner = serviceOwner();
  const workingN = sum ? sum.working.length + (sum.poBusy ? 1 : 0) : 0;
  tray.setToolTip(!up ? L('Hivelane · 서버 멈춤', 'Hivelane · Server stopped') : `Hivelane · ${sum?.need ? L(`확인할 것 ${sum.need}개 · `, `${sum.need} need you · `) : ''}${workingN ? L(`일하는 중 ${workingN}`, `${workingN} working`) : L('쉬는 중', 'Idle')}`);
  const needItems = (sum?.needTeams ?? []).slice(0, 6).map((t) => ({ label: `   ${t.title ?? t.name ?? t.id}${t.question ? L(' — 답 기다림', ' — waiting for answer') : t.state === 'failed' ? L(' — 실패', ' — failed') : t.state === 'down' ? L(' — 멈춤', ' — stopped') : ''}`, click: () => void openAt(`#team-${t.id}`) }));
  const workItems = (sum?.working ?? []).slice(0, 6).map((t) => ({ label: `   ${t.title ?? t.name ?? t.id}`, click: () => void openAt(`#team-${t.id}`) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: up ? L('● 서버 실행 중', '● Server running') : L('○ 서버 멈춤 — 눌러서 시작 화면 열기', '○ Server stopped — click to open setup'), click: () => void openMain() },
    ...(sum?.need ? [{ type: 'separator' }, { label: L(`확인할 것 ${sum.need}개`, `Needs you: ${sum.need}`), click: () => void openAt('#home') }, ...(sum.proposals ? [{ label: L(`   총괄 제안 승인 ${sum.proposals}건`, `   Lead proposals to approve: ${sum.proposals}`), click: () => void openAt('#po') }] : []), ...needItems] : []),
    ...(workingN ? [{ type: 'separator' }, { label: L(`일하는 중 ${workingN}`, `Working: ${workingN}`), click: () => void openAt('#home') }, ...(sum?.poBusy ? [{ label: L('   총괄 — 생각 중', '   Lead — thinking'), click: () => void openAt('#po') }] : []), ...workItems] : []),
    { type: 'separator' },
    { label: L('Hivelane 열기', 'Open Hivelane'), click: () => void openMain() },
    { label: L('브라우저로 열기', 'Open in browser'), click: () => void shell.openExternal(BASE) },
    { label: L('서버 다시 시작', 'Restart server'), enabled: owner !== null, click: async () => { await restartService(); await refreshTray(); win?.reload(); } },
    { label: L('기록 폴더 열기', 'Open logs folder'), click: () => void shell.openPath(LOGS) },
    { label: L('휴대폰 연결(Tailscale)…', 'Connect phone (Tailscale)…'), click: () => void connectPhone() },
    { label: L(`데이터 폴더 열기 (${DATA.replace(homedir(), '~')})`, `Open data folder (${DATA.replace(homedir(), '~')})`), click: () => void shell.openPath(DATA) },
    { type: 'separator' },
    owner === 'other'
      ? { label: L('서버 끄기 — 터미널로 설치한 서버라 터미널에서 npm run service:uninstall', 'Stop server — installed from Terminal, run npm run service:uninstall there'), enabled: false }
      : { label: L('서버 끄기(상시 실행 해제)', 'Stop server (turn off always-on)'), enabled: owner === 'app', click: async () => {
        const r = await dialog.showMessageBox({ type: 'warning', buttons: [L('끄기', 'Stop'), L('취소', 'Cancel')], defaultId: 1, message: L('서버를 끄면 일하던 팀이 모두 멈추고, 다시 켤 때까지 휴대폰에서도 접속할 수 없습니다.', 'Stopping the server pauses every working team, and your phone cannot connect until you start it again.') });
        if (r.response === 0) { uninstallService(); await refreshTray(); showSetup(); }
      } },
    { label: L('Hivelane 앱 종료(서버는 계속 실행)', 'Quit Hivelane app (server keeps running)'), click: () => { quitting = true; app.quit(); } },
  ]));
}

/** tailscale serve 로 내 tailnet 안에서만 열리는 주소를 만들고 알려 준다 */
function serveTailscale() {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: L('Tailscale 이 설치되어 있지 않습니다.', 'Tailscale is not installed.') };
  const r = ts(bin, ['serve', '--bg', String(REMOTE_PORT)]);
  const url = tsUrl(ts(bin, ['serve', 'status']).out);
  if (!r.ok || !url) return { ok: false, error: r.out || L('Tailscale 이 로그인되어 있는지, 관리 화면에서 HTTPS 인증서(HTTPS Certificates)가 켜져 있는지 확인하세요.', 'Check that Tailscale is logged in and that HTTPS Certificates are enabled in the admin console.') };
  return { ok: true, url };
}
async function connectPhone() {
  const r = serveTailscale();
  if (!r.ok) {
    const b = await dialog.showMessageBox({ type: 'warning', buttons: [L('Tailscale 받기', 'Get Tailscale'), L('닫기', 'Close')], defaultId: 1, message: L('휴대폰 연결을 만들지 못했습니다.', 'Could not set up the phone connection.'), detail: `${r.error ?? ''}\n\n${L('맥과 휴대폰에 Tailscale 을 설치하고 같은 계정으로 로그인한 뒤 다시 누르세요.', 'Install Tailscale on your Mac and phone, log in with the same account, then try again.')}` });
    if (b.response === 0) void shell.openExternal('https://tailscale.com/download');
    return;
  }
  const b = await dialog.showMessageBox({ type: 'info', buttons: [L('주소 복사', 'Copy address'), L('닫기', 'Close')], defaultId: 0, cancelId: 1, message: L('휴대폰에서 이 주소를 여세요', 'Open this address on your phone'), detail: `${r.url}\n\n${L('처음 열면 거절됩니다. 그다음 맥의 관제실 화면 › 설정 › 원격 접속에서 그 계정을 「주인으로 등록」하세요.', 'The first visit is refused. Then, on your Mac, go to Settings › Remote access and register that account as the owner.')}` });
  if (b.response === 0) clipboard.writeText(r.url);
}


/* ---------- IPC (setup.html) ---------- */

ipcMain.handle('hl:status', () => status());
ipcMain.handle('hl:install', async () => { const r = await installService(); await refreshTray(); return r; });
ipcMain.handle('hl:tailscale', () => serveTailscale());
ipcMain.handle('hl:open', () => showApp());
ipcMain.handle('hl:focus', () => { if (!win) createWindow(); win?.show(); win?.focus(); app.focus({ steal: true }); });
ipcMain.handle('hl:copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('hl:link', (_e, url) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); });
ipcMain.handle('hl:installCLT', () => { sh('xcode-select', ['--install']); return true; });

/* ---------- 시작 ---------- */

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => void openMain());
app.on('activate', () => void openMain());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* 메뉴 막대에 남는다 */ });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  tray = new Tray(icon('idle')); // @2x 는 자동으로 고른다
  // 앱을 다른 곳으로 옮겼으면(경로가 바뀜) 이 앱이 등록한 서비스를 새 경로로 다시 등록한다
  if (existsSync(PLIST) && serviceOwner() === 'other' && readFileSync(PLIST, 'utf8').includes('ELECTRON_RUN_AS_NODE')) await installService();
  await refreshTray();
  setInterval(() => void refreshTray(), 5000);
  await openMain();
  // 점검용: HIVELANE_CAPTURE=파일.png 이면 창을 찍어 저장하고 끝낸다(화면 확인 자동화)
  if (process.env.HIVELANE_CAPTURE) {
    await sleep(Number(process.env.HIVELANE_CAPTURE_WAIT ?? 4000));
    const img = await win?.webContents.capturePage();
    if (img) writeFileSync(process.env.HIVELANE_CAPTURE, img.toPNG());
    console.log('[capture] tray', JSON.stringify({ up: last.up, need: last.sum?.need, working: last.sum?.working.map((t) => t.title ?? t.name), poBusy: last.sum?.poBusy }));
    quitting = true; app.quit();
  }
});
