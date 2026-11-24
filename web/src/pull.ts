/**
 * 휴대폰: 맨 위에서 아래로 당기면 새로고침.
 * 설치한 앱(바로가기)은 브라우저의 당겨서 새로고침이 없어서 직접 만든다.
 * 새로고침은 주소 뒤에 값을 붙여 크롬이 예전에 받아 둔 화면 파일을 쓰지 않게 한다.
 */
const THRESHOLD = 80;

function scrollParent(el: Element | null): HTMLElement | null {
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

export function freshReload(): void {
  location.replace(`/?r=${Date.now().toString(36)}${location.hash}`);
}

export function installPullToRefresh(): void {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const bar = document.createElement('div');
  bar.className = 'ptr';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);

  let startY = 0;
  let pulling = false;
  let dist = 0;
  const show = (d: number) => {
    bar.style.transform = `translate(-50%, ${Math.min(d, THRESHOLD + 30) - 44}px)`;
    bar.style.opacity = String(Math.min(1, d / THRESHOLD));
    bar.textContent = d >= THRESHOLD ? '놓으면 새로고침' : '↓ 당겨서 새로고침';
    bar.classList.toggle('ready', d >= THRESHOLD);
  };
  const reset = () => { pulling = false; dist = 0; bar.style.transform = ''; bar.style.opacity = '0'; bar.classList.remove('ready'); };

  addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.target as Element;
    if (t.closest('textarea, input, select, [contenteditable], .rt-table, .ptr-off')) return;
    const sp = scrollParent(t);
    if (sp && sp.scrollTop > 0) return;
    if (document.scrollingElement && document.scrollingElement.scrollTop > 0) return;
    startY = e.touches[0]!.clientY;
    pulling = true;
    dist = 0;
  }, { passive: true });

  addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const d = e.touches[0]!.clientY - startY;
    if (d <= 0) { reset(); return; }
    dist = d * 0.5;
    show(dist);
  }, { passive: true });

  addEventListener('touchend', () => {
    if (!pulling) return;
    const go = dist >= THRESHOLD;
    reset();
    if (go) { bar.textContent = '새로고침 중…'; bar.style.opacity = '1'; bar.style.transform = 'translate(-50%, 8px)'; freshReload(); }
  });
  addEventListener('touchcancel', reset);
}
