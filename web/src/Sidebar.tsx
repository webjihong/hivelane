import { useEffect, useState } from 'react';
import type { StateSnapshot, TeamView } from '../../shared/types.ts';
import { DOT_LABEL, dotOf, isActiveTask, isDoneTask, isStandingCh, nowCount, sideNote } from './chan.ts';
import { api, clock, conn, route, useBox, type Route } from './store.ts';
import { RichText } from './ui.tsx';

const ZONE = { green: '여유', yellow: '주의', red: '과부하' } as const;

function Bar({ v, y, r }: { v: number; y: number; r: number }) {
  const c = v > r ? 'var(--sb-crit)' : v >= y ? 'var(--sb-warn)' : 'var(--sb-good)';
  return <span className="sb-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(2, v))}%`, background: c }} /></span>;
}

function ResourceModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { void api<{ text: string }>('/api/system/diag').then((r) => setText(r.text)).catch((e) => setText(`불러오지 못했습니다: ${e instanceof Error ? e.message : e}`)); }, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', h); return () => removeEventListener('keydown', h); }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="맥 리소스 상세">
        <div className="drawer-h"><div><h2>맥 리소스 · 누가 쓰나</h2><div className="drawer-sub muted">출처별 합계(Claude Code 세션·앱·Hivelane 팀)와 상위 프로세스</div></div><button className="btn" type="button" onClick={onClose}>닫기</button></div>
        <div className="drawer-b">{text ? <div className="diag"><RichText text={text} /></div> : <div className="muted">재는 중…</div>}</div>
      </aside>
    </>
  );
}

function TeamItem({ t, r, now }: { t: TeamView; r: Route; now: number }) {
  const dot = dotOf(t);
  const note = sideNote(t, now);
  const on = r.name === 'team' && r.id === t.id;
  const loud = t.unread > 0 || dot === 'ask';
  return (
    <a href={`#team-${t.id}`} className={`sb-item${on ? ' on' : ''}${loud ? ' loud' : ''}${dot === 'idle' ? ' dim' : ''}`} title={`${t.title || t.name} · ${DOT_LABEL[dot]}${t.busy_note ? ` · ${t.busy_note}` : ''}`}>
      <span className={`sdot ${dot}`} aria-label={DOT_LABEL[dot]} />
      <span className="sb-name">{t.title || t.name}</span>
      {note && (note.cls === 'b-ask' ? <span className="sb-badge ask">{note.text}</span> : <span className={`sb-note ${note.cls}`}>{note.text}</span>)}
      {t.unread > 0 && dot !== 'ask' && <span className="sb-badge">{t.unread}</span>}
    </a>
  );
}

export function Sidebar({ snap }: { snap: StateSnapshot }) {
  const r = useBox(route);
  const now = useBox(clock);
  const c = useBox(conn);
  const [showDone, setShowDone] = useState(() => { try { return localStorage.getItem('hl.done') === '1'; } catch { return false; } });
  const [diag, setDiag] = useState(false);
  const toggleDone = () => { setShowDone(!showDone); try { localStorage.setItem('hl.done', showDone ? '0' : '1'); } catch { /* 저장 안 됨 */ } };
  const standing = snap.teams.filter(isStandingCh);
  const tasks = snap.teams.filter(isActiveTask).sort((a, b) => ({ waiting_human: 0, failed: 1, running: 2, paused: 3, queued: 4 } as Record<string, number>)[a.state]! - ({ waiting_human: 0, failed: 1, running: 2, paused: 3, queued: 4 } as Record<string, number>)[b.state]! || b.created_at.localeCompare(a.created_at));
  const done = snap.teams.filter(isDoneTask);
  const openPrs = snap.prs.filter((p) => p.state === 'OPEN');
  const { need, news } = nowCount(snap);
  const res = snap.resource;
  const e = snap.settings.engine;
  const nowOn = r.name === 'now' || r.name === 'home';
  const poPending = snap.proposals.filter((p) => p.status === 'pending').length;

  return (
    <nav className="sb" aria-label="채널">
      <div className="sb-top">
        <a href="#now" className="sb-logo" aria-label="Hivelane 지금 볼 것">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8.5 5v10L12 22l-8.5-5V7z" fill="none" stroke="#7FC8C8" strokeWidth="2" /><path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z" fill="#F2B33D" /></svg>
          Hivelane
        </a>
        {snap.access === 'remote' && <span className="sb-remote">원격</span>}
        <a href="#settings" className={`sb-icon${r.name === 'settings' || r.name === 'templates' ? ' on' : ''}`} aria-label="설정" title="설정 · 팀 템플릿 · 프로젝트 · 알림">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
        </a>
      </div>

      <div className="sb-scroll">
        <a href="#now" className={`sb-now${nowOn ? ' on' : ''}${need ? ' need' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l4 4L20 5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          지금 볼 것
          {need + news > 0 && <span className="sb-now-n">{need + news}</span>}
        </a>
        <a href="#po" className={`sb-item sb-po${r.name === 'po' ? ' on' : ''}${snap.poUnread || poPending ? ' loud' : ''}`}>
          <span className={`sdot ${snap.poBusy ? 'run' : 'idle'}`} aria-label={snap.poBusy ? '생각 중' : '대기'} />
          <span className="sb-name">PO</span>
          {poPending > 0 ? <span className="sb-badge ask">제안 {poPending}</span> : snap.poUnread > 0 ? <span className="sb-badge">{snap.poUnread}</span> : <span className={`sb-note ${snap.poBusy ? 't-run' : 't-muted'}`}>{snap.poBusy ? '생각 중' : '대기'}</span>}
        </a>

        <div className="sb-h">직속 팀<a href="#settings" className="sb-add" aria-label="직속 팀 추가" title="직속 팀 추가(설정)">＋</a></div>
        {standing.length ? standing.map((t) => <TeamItem key={t.id} t={t} r={r} now={now} />) : <div className="sb-empty">없음 · PO에게 「직속팀 만들어줘」</div>}

        <div className="sb-h">업무 팀</div>
        {tasks.length ? tasks.map((t) => <TeamItem key={t.id} t={t} r={r} now={now} />) : <div className="sb-empty">진행 중인 업무 없음</div>}
        {done.length > 0 && <button type="button" className="sb-more" onClick={toggleDone}>{showDone ? '끝난 팀 접기' : `끝난 팀 ${done.length}`}</button>}
        {showDone && done.map((t) => <TeamItem key={t.id} t={t} r={r} now={now} />)}

        <div className="sb-h">PR<a href="#prs" className="sb-add" title="PR 전체">전체</a></div>
        {openPrs.length ? openPrs.slice(0, 6).map((p) => (
          <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="sb-item" title={`${p.project_name} #${p.number} ${p.title} · ${p.base} ← ${p.head}`}>
            <span className={`sb-pr${p.draft ? ' draft' : ''}`}>{p.draft ? '초안' : '열림'}</span>
            <span className="sb-name">#{p.number} {p.title}</span>
            <span className="sb-note t-muted">↗</span>
          </a>
        )) : <div className="sb-empty">열린 PR 없음</div>}
      </div>

      <button type="button" className="sb-res" onClick={() => setDiag(true)} title={`${ZONE[res.zone]} · 무거운 명령 ${res.heavyRunning} 실행 · ${res.heavyWaiting} 대기 · ${c === 'down' ? '서버 연결 끊김' : '서버 연결됨'} — 누르면 누가 쓰는지 보기`}>
        <span className={`sb-zone ${res.zone}`}>{ZONE[res.zone]}</span>
        <span className="sb-k">CPU</span><Bar v={res.cpu} y={e.cpuY} r={e.cpuR} /><span className="mono">{Math.round(res.cpu)}%</span>
        <span className="sb-k">메모리</span><Bar v={res.mem} y={e.memY} r={e.memR} /><span className="mono">{Math.round(res.mem)}%</span>
        {c === 'down' && <span className="sb-down" aria-label="서버 연결 끊김">●</span>}
      </button>
      {diag && <ResourceModal onClose={() => setDiag(false)} />}
    </nav>
  );
}
