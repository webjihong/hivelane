import { useState } from 'react';
import type { PrView, StateSnapshot } from '../../shared/types.ts';
import { act, api, clock, go, refreshState, useBox } from './store.ts';

const STATE: Record<PrView['state'], string> = { OPEN: '열림', MERGED: '병합됨', CLOSED: '닫힘' };
const REVIEW: Record<string, string> = { APPROVED: '승인', CHANGES_REQUESTED: '수정 요청', REVIEW_REQUIRED: '리뷰 대기' };
const CHECKS: Record<PrView['checks'], string> = { pass: '검사 통과', fail: '검사 실패', pending: '검사 중', none: '' };

function ago(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

export function PrRow({ pr, snap }: { pr: PrView; snap: StateSnapshot }) {
  const now = useBox(clock);
  const team = pr.team_id ? snap.teams.find((t) => t.id === pr.team_id) : null;
  return (
    <a className={`pr-row s-${pr.state.toLowerCase()}`} href={pr.url} target="_blank" rel="noreferrer">
      <span className={`pr-state ${pr.state.toLowerCase()}${pr.draft ? ' draft' : ''}`}>{pr.draft && pr.state === 'OPEN' ? '초안' : STATE[pr.state]}</span>
      <div className="pr-main">
        <div className="pr-t"><span className="muted mono">#{pr.number}</span> {pr.title}</div>
        <div className="pr-s muted">
          <span className="chip">{pr.project_name}</span>
          <span className="mono">{pr.base} ← {pr.head}</span>
          {pr.author && <span>· {pr.author}</span>}
          <span>· {ago(pr.merged_at ?? pr.updated_at, now)}</span>
          {team && <button type="button" className="pr-team" onClick={(e) => { e.preventDefault(); go(`team-${team.id}`); }}>팀 「{team.title || team.name}」</button>}
        </div>
      </div>
      <div className="pr-badges">
        {pr.checks !== 'none' && <span className={`pr-b ${pr.checks}`}>{CHECKS[pr.checks]}</span>}
        {pr.review && REVIEW[pr.review] && <span className={`pr-b r-${pr.review.toLowerCase()}`}>{REVIEW[pr.review]}</span>}
        <span className="pr-go" aria-hidden="true">↗</span>
      </div>
    </a>
  );
}

/** 저장소별 PR: 열린 것 먼저, 최근 3일 안에 병합·닫힌 것은 접어서 */
export function PrSection({ snap }: { snap: StateSnapshot }) {
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = snap.prs.filter((p) => p.state === 'OPEN');
  const closed = snap.prs.filter((p) => p.state !== 'OPEN');
  const errs = Object.entries(snap.prErrors);
  const refresh = async () => { setBusy(true); await act(() => api('/api/prs/refresh', 'POST', {})); await refreshState(); setBusy(false); };
  return (
    <section>
      <div className="section-h">
        <h2>PR <small className="muted">열림 {open.length}</small></h2>
        <div className="row">
          {closed.length > 0 && <button className="back" type="button" onClick={() => setShowClosed(!showClosed)}>{showClosed ? '최근 병합·닫힘 숨기기' : `최근 병합·닫힘 ${closed.length}`}</button>}
          <button className="back" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '불러오는 중…' : '새로고침'}</button>
        </div>
      </div>
      {open.length || showClosed ? (
        <div className="pr-list">
          {open.map((p) => <PrRow key={p.url} pr={p} snap={snap} />)}
          {showClosed && closed.map((p) => <PrRow key={p.url} pr={p} snap={snap} />)}
        </div>
      ) : <div className="all-clear" style={{ color: 'var(--muted)', background: 'var(--surface-2)' }}>열린 PR 이 없습니다. 2분마다 등록된 저장소에서 다시 읽습니다.</div>}
      {errs.length > 0 && <div className="muted small" style={{ marginTop: 6 }}>{errs.map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>}
    </section>
  );
}
