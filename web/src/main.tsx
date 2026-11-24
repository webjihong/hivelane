import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect, refreshChat, refreshState } from './store.ts';
import { applyPrefs, loadPrefs } from './themes.ts';

applyPrefs(loadPrefs()); // 첫 그림 전에 테마·글자 크기

/** 화면 한 군데 오류로 전체가 하얗게 멈추지 않게: 이유와 다시 불러오기를 보여 준다. */
class Guard extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error) { console.error('[Hivelane 화면 오류]', error); }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        <b>화면을 그리다 오류가 났습니다.</b>
        <span className="muted">서버와 화면 버전이 잠깐 어긋났을 수 있습니다(서버 재시작 직전·직후). 다시 불러오면 대부분 해결됩니다.</span>
        <code className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{String(this.state.error.message).slice(0, 300)}</code>
        <button className="btn primary" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => location.reload()}>다시 불러오기</button>
      </div>
    );
  }
}

const el = document.getElementById('root');
if (!el) throw new Error('#root 가 없습니다');
createRoot(el).render(<StrictMode><Guard><App /></Guard></StrictMode>);

void refreshState();
void refreshChat();
connect();

// 푸시 알림을 이미 켠 기기는 서비스 워커를 계속 등록해 둔다.
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration('/sw.js').then((r) => { if (r) void r.update(); }).catch(() => {});

// 서버가 새 화면으로 바뀌었으면 새로 불러온다(홈 화면 앱이 예전 화면을 붙잡고 있지 않게).
// 같은 빌드로는 한 번만 시도해 무한 새로고침을 막는다.
const myBuild = document.querySelector<HTMLScriptElement>('script[src*="/assets/"]')?.getAttribute('src') ?? null;
async function checkBuild(): Promise<void> {
  if (!myBuild || document.visibilityState !== 'visible') return;
  try {
    const j = await (await fetch('/api/health', { cache: 'no-store' })).json() as { build?: string | null };
    if (!j.build || j.build === myBuild || sessionStorage.getItem('hl-reload-for') === j.build) return;
    sessionStorage.setItem('hl-reload-for', j.build);
    location.replace(`/?b=${encodeURIComponent(j.build.replace(/^.*index-|\.js$/g, ''))}${location.hash}`);
  } catch { /* 서버 재시작 중이면 다음에 */ }
}
document.addEventListener('visibilitychange', () => void checkBuild());
setInterval(() => void checkBuild(), 60_000);
void checkBuild();
