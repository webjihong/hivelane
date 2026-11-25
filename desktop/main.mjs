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
  return { ok: false, error: `launchctl bootstrap 실패: ${last}`, log: LOGS };
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
  win.loadFile(join(HERE, 'setup.html'));
}
async function showApp() {
  if (!win) createWindow();
  await win.loadURL(`${BASE}/?app=desktop#home`);
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

async function refreshTray() {
  if (!tray) return;
  const up = await healthy();
  const owner = serviceOwner();
  tray.setToolTip(up ? 'Hivelane · 서버 실행 중' : 'Hivelane · 서버 멈춤');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: up ? '● 서버 실행 중' : '○ 서버 멈춤', enabled: false },
    { label: `데이터: ${DATA}`, enabled: false },
    { type: 'separator' },
    { label: 'Hivelane 열기', click: () => void openMain() },
    { label: '브라우저로 열기', click: () => void shell.openExternal(BASE) },
    { label: '서버 다시 시작', enabled: owner !== null, click: async () => { await restartService(); await refreshTray(); win?.reload(); } },
    { label: '기록 폴더 열기', click: () => void shell.openPath(LOGS) },
    { label: '휴대폰 연결(Tailscale)…', click: () => void connectPhone() },
    { type: 'separator' },
    { label: '서버 끄기(상시 실행 해제)', enabled: owner === 'app', click: async () => {
      const r = await dialog.showMessageBox({ type: 'warning', buttons: ['끄기', '취소'], defaultId: 1, message: '서버를 끄면 일하던 팀이 모두 멈추고, 다시 켤 때까지 휴대폰에서도 접속할 수 없습니다.' });
      if (r.response === 0) { uninstallService(); await refreshTray(); showSetup(); }
    } },
    { label: 'Hivelane 앱 종료(서버는 계속 실행)', click: () => { quitting = true; app.quit(); } },
  ]));
}

/** tailscale serve 로 내 tailnet 안에서만 열리는 주소를 만들고 알려 준다 */
function serveTailscale() {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: 'Tailscale 이 설치되어 있지 않습니다.' };
  const r = ts(bin, ['serve', '--bg', String(REMOTE_PORT)]);
  const url = tsUrl(ts(bin, ['serve', 'status']).out);
  if (!r.ok || !url) return { ok: false, error: r.out || 'Tailscale 이 로그인되어 있는지, 관리 화면에서 HTTPS 인증서(HTTPS Certificates)가 켜져 있는지 확인하세요.' };
  return { ok: true, url };
}
async function connectPhone() {
  const r = serveTailscale();
  if (!r.ok) {
    const b = await dialog.showMessageBox({ type: 'warning', buttons: ['Tailscale 받기', '닫기'], defaultId: 1, message: '휴대폰 연결을 만들지 못했습니다.', detail: `${r.error ?? ''}\n\n맥과 휴대폰에 Tailscale 을 설치하고 같은 계정으로 로그인한 뒤 다시 누르세요.` });
    if (b.response === 0) void shell.openExternal('https://tailscale.com/download');
    return;
  }
  const b = await dialog.showMessageBox({ type: 'info', buttons: ['주소 복사', '닫기'], defaultId: 0, cancelId: 1, message: '휴대폰에서 이 주소를 여세요', detail: `${r.url}\n\n처음 열면 거절됩니다. 그다음 맥의 관제실 화면 › 설정 › 원격 접속에서 그 계정을 「주인으로 등록」하세요.` });
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
  const icon = nativeImage.createFromPath(join(HERE, 'trayTemplate.png')); // @2x 는 자동으로 고른다
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  // 앱을 다른 곳으로 옮겼으면(경로가 바뀜) 이 앱이 등록한 서비스를 새 경로로 다시 등록한다
  if (existsSync(PLIST) && serviceOwner() === 'other' && readFileSync(PLIST, 'utf8').includes('ELECTRON_RUN_AS_NODE')) await installService();
  await refreshTray();
  setInterval(() => void refreshTray(), 15000);
  await openMain();
  // 점검용: HIVELANE_CAPTURE=파일.png 이면 창을 찍어 저장하고 끝낸다(화면 확인 자동화)
  if (process.env.HIVELANE_CAPTURE) {
    await sleep(Number(process.env.HIVELANE_CAPTURE_WAIT ?? 4000));
    const img = await win?.webContents.capturePage();
    if (img) writeFileSync(process.env.HIVELANE_CAPTURE, img.toPNG());
    quitting = true; app.quit();
  }
});
