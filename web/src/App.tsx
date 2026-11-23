import { useEffect, type ReactElement } from 'react';
import type { StateSnapshot } from '../../shared/types.ts';
import { AgentDrawer } from './AgentDrawer.tsx';
import { Chat } from './Chat.tsx';
import { Home, isLine, isStanding } from './Home.tsx';
import { Settings } from './Settings.tsx';
import { Team } from './Team.tsx';
import { Templates } from './Templates.tsx';
import { conn, openAgent, route, snapshot, toasts, useBox } from './store.ts';

const ZONE = { green: '초록 구간', yellow: '노랑 구간', red: '빨강 구간' } as const;

function Gauge({ label, v, y, r }: { label: string; v: number; y: number; r: number }) {
  const bg = v > r ? 'var(--crit)' : v >= y ? 'var(--warn)' : 'var(--good)';
  return (
    <div className="gauge"><span>{label}</span>
      <div className="bar"><div className="fill" style={{ width: `${Math.min(100, Math.max(0, v))}%`, background: bg }} /><div className="tick" style={{ left: `${y}%` }} /><div className="tick" style={{ left: `${r}%` }} /></div>
      <span className="mono">{Math.round(v)}%</span>
    </div>
  );
}

function Top({ snap, routeName }: { snap: StateSnapshot | null; routeName: string }) {
  const c = useBox(conn);
  const lines = snap?.teams.filter(isLine) ?? [];
  const n = (s: string) => lines.filter((t) => t.state === s).length;
  const e = snap?.settings.engine;
  const res = snap?.resource;
  const onHome = routeName !== 'templates' && routeName !== 'settings';
  return (
    <header className="top">
      <div className="top-in">
        <div className="brand"><b>Hivelane 관제실</b>{snap && <span>{snap.access === 'remote' ? '원격 접속 · 보기 위주' : '로컬'}</span>}</div>
        <nav className="tabs" aria-label="화면">
          <a href="#home" className={onHome ? 'on' : ''}>업무</a>
          <a href="#templates" className={routeName === 'templates' ? 'on' : ''}>팀 템플릿</a>
          <a href="#settings" className={routeName === 'settings' ? 'on' : ''}>설정</a>
        </nav>
        {snap && e && res && (
          <div className="gauges" aria-label="로컬 리소스">
            <Gauge label="CPU" v={res.cpu} y={e.cpuY} r={e.cpuR} />
            <Gauge label="메모리" v={res.mem} y={e.memY} r={e.memR} />
            <span className={`zone ${res.zone}`}>{ZONE[res.zone]}</span>
          </div>
        )}
        {snap && res && (
          <div className="counts">
            <span>실행 <b>{n('running')}</b></span><span>멈춤 <b>{n('paused')}</b></span><span>대기 <b>{n('queued')}</b></span>
            <span>사람 확인 <b>{n('waiting_human')}</b></span>{n('failed') > 0 && <span>실패 <b>{n('failed')}</b></span>}
            <span>무거운 명령 <b>{res.heavyRunning}</b> 실행 · <b>{res.heavyWaiting}</b> 대기</span>
          </div>
        )}
        <div className="top-r">
          {snap?.poBusy && <span className="po-pill"><span className="typing"><span /><span /><span /></span> PO 생각 중</span>}
          {c === 'down' && <span className="conn-pill">연결 끊김 · 다시 연결 중</span>}
        </div>
      </div>
    </header>
  );
}

function BottomNav({ snap, routeName }: { snap: StateSnapshot | null; routeName: string }) {
  const need = snap ? snap.teams.filter((t) => (isLine(t) && (t.state === 'waiting_human' || t.state === 'paused' || t.state === 'failed')) || (isStanding(t) && (t.state === 'down' || t.state === 'reviving' || t.state === 'waiting_human'))).length : 0;
  const unread = snap ? snap.teams.reduce((a, t) => a + (t.state === 'archived' ? 0 : t.unread), 0) : 0;
  const home = routeName !== 'templates' && routeName !== 'settings' && routeName !== 'po';
  return (
    <nav className="bnav" aria-label="화면">
      <a href="#home" className={home ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 20V9l5 3V9l5 3V6l8 4v10z" /><path d="M3 20h18" /></svg>현황{need + unread > 0 && <span className="badge">{need + unread}</span>}</a>
      <a href="#po" className={routeName === 'po' ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>PO{snap?.poUnread ? <span className="badge">{snap.poUnread}</span> : snap?.poBusy && <span className="badge dot" />}</a>
      <a href="#templates" className={routeName === 'templates' ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><path d="M3 19c0-3 2.5-5 5-5s5 2 5 5M11 19c0-3 2.5-5 5-5s5 2 5 5" /></svg>템플릿</a>
      <a href="#settings" className={routeName === 'settings' ? 'on' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>설정</a>
    </nav>
  );
}

function Toasts() {
  const list = useBox(toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className={`toast ${t.tone}`} onClick={() => toasts.set((l) => l.filter((x) => x.id !== t.id))}>{t.text}</div>)}
    </div>
  );
}

export function App() {
  const snap = useBox(snapshot);
  const r = useBox(route);
  const agent = useBox(openAgent);

  useEffect(() => { document.body.classList.toggle('r-po', r.name === 'po'); }, [r.name]);
  // 읽지 않은 수: 탭 제목·앱 아이콘 배지
  const unreadTotal = snap ? snap.poUnread + snap.teams.reduce((a, t) => a + (t.state === 'archived' ? 0 : t.unread), 0) : 0;
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) Hivelane 관제실` : 'Hivelane 관제실';
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (unreadTotal ? nav.setAppBadge?.(unreadTotal) : nav.clearAppBadge?.())?.catch(() => {}); } catch { /* 지원 안 함 */ }
  }, [unreadTotal]);
  useEffect(() => { if (r.name !== 'team') openAgent.set(null); }, [r]);

  let main: ReactElement;
  if (!snap) main = <div className="panel muted">불러오는 중…</div>;
  else if (r.name === 'templates') main = <Templates snap={snap} />;
  else if (r.name === 'settings') main = <Settings snap={snap} />;
  else if (r.name === 'team') main = <Team key={r.id} id={r.id} snap={snap} />;
  else main = <Home snap={snap} />;

  return (
    <>
      <Top snap={snap} routeName={r.name} />
      <div className="shell">
        <main className="main">{main}</main>
        {snap ? <Chat snap={snap} /> : <aside className="chat" aria-label="PO 대화창" />}
      </div>
      <BottomNav snap={snap} routeName={r.name} />
      {agent && snap && <AgentDrawer key={agent} id={agent} snap={snap} />}
      <Toasts />
    </>
  );
}
