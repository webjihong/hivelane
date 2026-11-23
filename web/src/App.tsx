import { useEffect, useState, type ReactElement } from 'react';
import type { StateSnapshot } from '../../shared/types.ts';
import { AgentDrawer } from './AgentDrawer.tsx';
import { nowCount } from './chan.ts';
import { Chat } from './Chat.tsx';
import { Now } from './Now.tsx';
import { PrSection } from './Prs.tsx';
import { Settings } from './Settings.tsx';
import { Scripts } from './Scripts.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TeamChannel } from './TeamChannel.tsx';
import { Templates } from './Templates.tsx';
import { api, conn, openAgent, route, snapshot, toasts, useBox, type Route } from './store.ts';

const MOBILE = '(max-width: 760px)';
function useMobile(): boolean {
  const [m, setM] = useState(() => matchMedia(MOBILE).matches);
  useEffect(() => { const q = matchMedia(MOBILE); const h = () => setM(q.matches); q.addEventListener('change', h); return () => q.removeEventListener('change', h); }, []);
  return m;
}

function Toasts() {
  const list = useBox(toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className={`toast ${t.tone}`} onClick={() => toasts.set((l) => l.filter((x) => x.id !== t.id))}>{t.text}</div>)}
    </div>
  );
}

/** 휴대폰 하단 탭: 대화(채널 목록) · PR · 설정 */
function BottomNav({ snap, r }: { snap: StateSnapshot; r: Route }) {
  const { need, news } = nowCount(snap);
  const chatOn = !['prs', 'scripts', 'settings', 'templates'].includes(r.name);
  const runningScripts = snap.scripts.filter((s) => s.running_run_id).length;
  const openPrs = snap.prs.filter((p) => p.state === 'OPEN').length;
  return (
    <nav className="bnav b4" aria-label="화면">
      <a href="#list" className={chatOn ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>대화{need + news > 0 && <span className="badge">{need + news}</span>}</a>
      <a href="#prs" className={r.name === 'prs' ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-4" /></svg>PR{openPrs > 0 && <span className="badge dim">{openPrs}</span>}</a>
      <a href="#scripts" className={r.name === 'scripts' ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></svg>스크립트{runningScripts > 0 && <span className="badge dot" />}</a>
      <a href="#settings" className={r.name === 'settings' || r.name === 'templates' ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>설정</a>
    </nav>
  );
}

function SettingsTabs({ r }: { r: Route }) {
  return (
    <nav className="set-tabs" aria-label="설정 구역">
      <a href="#settings" className={r.name === 'settings' ? 'on' : ''}>설정</a>
      <a href="#templates" className={r.name === 'templates' ? 'on' : ''}>팀 템플릿</a>
    </nav>
  );
}

export function App() {
  const snap = useBox(snapshot);
  const r = useBox(route);
  const agent = useBox(openAgent);
  const c = useBox(conn);
  const mobile = useMobile();

  useEffect(() => { if (r.name !== 'team') openAgent.set(null); }, [r]);
  // 지금 보고 있는 대화를 서버에 알린다 → 그 대화의 답은 알림을 울리지 않는다
  const view = r.name === 'team' ? `team:${r.id}` : r.name === 'po' ? 'po' : null;
  useEffect(() => {
    let device = '';
    try { device = localStorage.getItem('hl.device') ?? ''; if (!device) { device = `d-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem('hl.device', device); } } catch { device = 'd-nostore'; }
    const tell = () => { void api('/api/presence', 'POST', { device, view: document.visibilityState === 'visible' && document.hasFocus() ? view : null }).catch(() => {}); };
    tell();
    const t = setInterval(tell, 25_000);
    document.addEventListener('visibilitychange', tell);
    addEventListener('focus', tell); addEventListener('blur', tell);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tell); removeEventListener('focus', tell); removeEventListener('blur', tell); };
  }, [view]);
  // 읽지 않은 수: 탭 제목·앱 아이콘 배지
  const unreadTotal = snap ? snap.poUnread + snap.teams.reduce((a, t) => a + (t.state === 'archived' ? 0 : t.unread), 0) : 0;
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) Hivelane` : 'Hivelane';
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (unreadTotal ? nav.setAppBadge?.(unreadTotal) : nav.clearAppBadge?.())?.catch(() => {}); } catch { /* 지원 안 함 */ }
  }, [unreadTotal]);

  if (!snap) return <div className="boot muted">{c === 'down' ? '서버에 연결하지 못했습니다 · 다시 시도 중' : '불러오는 중…'}</div>;

  // 휴대폰: 첫 화면은 채널 목록. 데스크톱: 첫 화면은 「지금 볼 것」
  const showList = mobile && (r.name === 'home' || r.name === 'list');
  let main: ReactElement;
  if (r.name === 'settings') main = <div className="page"><SettingsTabs r={r} /><Settings snap={snap} /></div>;
  else if (r.name === 'templates') main = <div className="page"><SettingsTabs r={r} /><Templates snap={snap} /></div>;
  else if (r.name === 'scripts') main = <div className="page"><Scripts snap={snap} /></div>;
  else if (r.name === 'prs') main = <div className="page"><PrSection key={r.focus ?? ''} snap={snap} focus={r.focus} /></div>;
  else if (r.name === 'po') main = <Chat snap={snap} />;
  else if (r.name === 'team') main = <TeamChannel key={r.id} id={r.id} snap={snap} detail={!!r.detail} />;
  else main = <div className="page"><Now snap={snap} /></div>;

  return (
    <>
      <div className={`app${mobile ? ' m' : ''}${showList ? ' m-list' : ''}`}>
        {(!mobile || showList) && <Sidebar snap={snap} />}
        {!showList && <main className="app-main">{mobile && r.name !== 'po' && r.name !== 'team' && <a href="#list" className="m-back">← 목록</a>}{main}</main>}
      </div>
      {mobile && <BottomNav snap={snap} r={r} />}
      {agent && <AgentDrawer key={agent} id={agent} snap={snap} />}
      <Toasts />
    </>
  );
}
