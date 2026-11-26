/**
 * README 스크린샷 찍기 — 데모 서버(scripts/readme-demo.ts 로 만든 HIVELANE_HOME)를 띄운 뒤:
 *   HL_URL=http://127.0.0.1:4391 HL_TEAMS='{"pay":"tm-…",…}' npx electron scripts/readme-shots.mjs
 * docs/images/*.png 로 저장한다. 실제 데이터로 찍지 않는다(이름·메일·경로가 나올 수 있음).
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.HL_URL ?? 'http://127.0.0.1:4391';
const T = JSON.parse(process.env.HL_TEAMS ?? '{}');
const LANG = process.env.HL_LANG === 'en' ? 'en' : 'ko'; // en: 영어 화면(docs/images/en)
const OUT = join(import.meta.dirname, '..', 'docs', 'images', ...(LANG === 'en' ? ['en'] : []));
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { file: 'now.png', hash: '#now', w: 1440, h: 900 },
  { file: 'po-chat.png', hash: '#po', w: 1440, h: 900 },
  { file: 'team-detail.png', hash: `#team-${T.pay}/detail`, w: 1440, h: 900 },
  { file: 'standing-team.png', hash: `#team-${T.ops}`, w: 1440, h: 900 },
  { file: 'backup.png', hash: '#settings/backup', w: 1440, h: 900 },
  { file: 'mobile.png', hash: '#now', w: 390, h: 844, mobile: true },
  { file: 'mobile-team.png', hash: `#team-${T.pay}`, w: 390, h: 844, mobile: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.commandLine.appendSwitch('force-device-scale-factor', '2'); // 선명하게(레티나 2배)
app.on('window-all-closed', () => {}); // 한 장 찍고 창을 닫아도 끝내지 않게

app.whenReady().then(async () => {
  const only = process.env.HL_ONLY?.split(',');
  for (const s of SHOTS.filter((x) => !only || only.includes(x.file))) {
    const win = new BrowserWindow({ width: s.w, height: s.h, show: false, useContentSize: true, webPreferences: { offscreen: false } });
    if (s.mobile) win.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await win.loadURL(`${URL}/`).catch(() => undefined);
    await sleep(800);
    await win.webContents.executeJavaScript(`localStorage.setItem('hl-lang', ${JSON.stringify(LANG)})`);
    await win.loadURL(`${URL}/`).catch(() => undefined);
    await sleep(800);
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(s.hash)}`);
    await sleep(2500);
    const img = await win.webContents.capturePage();
    writeFileSync(join(OUT, s.file), img.toPNG());
    console.log('wrote', s.file, img.getSize());
    win.destroy();
  }
  app.quit();
});
