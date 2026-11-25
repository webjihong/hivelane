/**
 * 앱 아이콘 PNG 만들기 — npx electron scripts/make-app-icons.mjs
 * web/public/icon.svg(벌집 세 칸, 메뉴 막대 아이콘과 같은 모양)를 512·192·180 PNG 로,
 * 알림 배지(단색 흰 벌집)를 96 PNG 로 그린다. 맥 앱 아이콘은 여백을 둔 icon-mac-512.png(build-desktop 이 씀).
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PUB = join(import.meta.dirname, '..', 'web', 'public');
const ICON = readFileSync(join(PUB, 'icon.svg'), 'utf8');
const BADGE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g fill="#FFFFFF" stroke="#FFFFFF" stroke-width="20" stroke-linejoin="round"><polygon points="168.3,133.0 244.5,177.0 244.5,265.0 168.3,309.0 92.1,265.0 92.1,177.0"/><polygon points="343.7,133.0 419.9,177.0 419.9,265.0 343.7,309.0 267.5,265.0 267.5,177.0"/><polygon points="256.0,284.9 332.2,328.9 332.2,416.9 256.0,460.9 179.8,416.9 179.8,328.9"/></g></svg>';

async function render(win, svg, size, file) {
  const html = `<html><body style="margin:0;background:transparent"><img id="i" width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await win.webContents.executeJavaScript('new Promise(r => { const i = document.getElementById("i"); i.complete ? r() : i.onload = r; })');
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  writeFileSync(join(PUB, file), img.resize({ width: size, height: size }).toPNG());
  console.log('wrote', file);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true }, useContentSize: true });
  win.webContents.setZoomFactor(1);
  for (const s of [512, 192, 180]) await render(win, ICON, s, `icon-${s}.png`);
  await render(win, BADGE, 96, 'badge-mono-96.png');
  // 맥 앱 아이콘: 다른 앱과 같은 크기로 보이게 둘레에 여백(824/1024, macOS 아이콘 격자)
  const MAC = ICON.replace('viewBox="0 0 512 512"', 'viewBox="-50 -50 612 612"');
  await render(win, MAC, 512, 'icon-mac-512.png');
  app.quit();
});
