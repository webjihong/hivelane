/**
 * 메뉴 막대 아이콘(벌집) 그리기 — npx electron scripts/make-tray-icons.mjs
 * 모든 프레임이 같은 크기(20×18pt)라서 그림만 바꿔 끼워도 옆 아이콘이 움직이지 않는다.
 * 검정+투명(template)으로 그려 macOS 가 밝은/어두운 메뉴 막대에 맞춰 색을 입힌다.
 *  - idle      : 벌집 세 칸(빈 칸)
 *  - work0..2  : 일하는 중 — 꿀이 차는 칸이 한 칸씩 돈다
 *  - attn / workattn0..2 : 확인할 것이 있음 — 오른쪽 위 점
 *  - off       : 서버 꺼짐 — 흐린 점선 벌집
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'desktop', 'tray');
const W = 20, H = 18;

function hex(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 90); pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`); }
  return pts.join(' ');
}
// 벌집 세 칸: 위 왼쪽 · 위 오른쪽 · 아래 가운데
const R = 4.3;
const CELLS = [[5.6, 6.0], [13.4, 6.0], [9.5, 12.6]];

function svg({ filled = -1, dot = false, off = false }) {
  const cells = CELLS.map(([x, y], i) => {
    const fill = i === filled ? 'black' : 'none';
    return `<polygon points="${hex(x, y, R)}" fill="${fill}" stroke="black" stroke-width="1.5" stroke-linejoin="round"${off ? ' stroke-dasharray="1.6 1.4" opacity="0.55"' : ''}/>`;
  }).join('');
  const badge = dot ? `<circle cx="17.2" cy="3.2" r="2.6" fill="black"/>` : '';
  // 점과 겹치는 칸 테두리를 지워 점이 또렷하게
  const cut = dot ? `<mask id="m"><rect width="${W}" height="${H}" fill="white"/><circle cx="17.2" cy="3.2" r="3.9" fill="black"/></mask>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${cut}</defs><g${dot ? ' mask="url(#m)"' : ''}>${cells}</g>${badge}</svg>`;
}

const FRAMES = {
  idle: {}, off: { off: true }, attn: { dot: true },
  work0: { filled: 0 }, work1: { filled: 1 }, work2: { filled: 2 },
  workattn0: { filled: 0, dot: true }, workattn1: { filled: 1, dot: true }, workattn2: { filled: 2, dot: true },
};

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 200, height: 200, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  for (const [name, opt] of Object.entries(FRAMES)) {
    for (const scale of [1, 2]) {
      const body = svg(opt).replace(`width="${W}" height="${H}"`, `width="${W * scale}" height="${H * scale}"`);
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${body}</body></html>`)}`);
      await new Promise((r) => setTimeout(r, 60));
      let img = await win.webContents.capturePage({ x: 0, y: 0, width: W * scale, height: H * scale });
      const sz = img.getSize();
      if (sz.width !== W * scale) img = img.resize({ width: W * scale, height: H * scale, quality: 'best' });
      writeFileSync(join(OUT, `${name}Template${scale === 2 ? '@2x' : ''}.png`), img.toPNG());
    }
  }
  console.log(`그렸습니다: ${OUT}`);
  app.quit();
});
