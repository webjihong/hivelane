import { useEffect, useRef, useState } from 'react';
import type { PrView, StateSnapshot } from '../../shared/types.ts';
import { act, api, clock, go, refreshState, useBox } from './store.ts';
import { ConfirmButton } from './ui.tsx';
import { t } from './i18n.ts';

const STATE: Record<PrView['state'], string> = { OPEN: t('열림'), MERGED: t('병합됨'), CLOSED: t('닫힘') };
const REVIEW: Record<string, string> = { APPROVED: t('승인@리뷰'), CHANGES_REQUESTED: t('수정 요청'), REVIEW_REQUIRED: t('리뷰 대기') };
const CHECKS: Record<PrView['checks'], string> = { pass: t('검사 통과'), fail: t('검사 실패'), pending: t('검사 중'), none: '' };

function ago(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 60) return t('{n}분 전', { n: m });
  const h = Math.round(m / 60);
  return h < 48 ? t('{n}시간 전', { n: h }) : t('{n}일 전', { n: Math.round(h / 24) });
}

const MERGE_STATE: Record<string, { text: string; ok: boolean }> = {
  CLEAN: { text: t('바로 병합 가능'), ok: true }, HAS_HOOKS: { text: t('병합 가능(훅 있음)'), ok: true }, UNSTABLE: { text: t('병합 가능 · 실패한 검사 있음'), ok: true },
  BEHIND: { text: t('기준 브랜치보다 뒤처짐 · 규칙상 최신화가 필요할 수 있음'), ok: true }, BLOCKED: { text: t('막힘 · 리뷰·필수 검사 등 보호 규칙'), ok: false },
  DIRTY: { text: t('충돌 · 병합 불가'), ok: false }, DRAFT: { text: t('초안 · 병합 불가'), ok: false }, UNKNOWN: { text: t('병합 가능 여부 계산 중'), ok: true },
};
const CHECK_ICON: Record<string, string> = { pass: '✓', fail: '✕', pending: '●', skip: '–' };

/** PR 화면 주소에 쓰는 키: 프로젝트:번호 */
export const prKey = (p: PrView) => `${p.project_id}:${p.number}`;

export function PrRow({ pr, snap, focused = false }: { pr: PrView; snap: StateSnapshot; focused?: boolean }) {
  const now = useBox(clock);
  const [open, setOpen] = useState(focused);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focused) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [focused]);
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('merge');
  const [busy, setBusy] = useState(false);
  const team = pr.team_id ? snap.teams.find((tm) => tm.id === pr.team_id) : null;
  const ms = MERGE_STATE[pr.draft ? 'DRAFT' : pr.merge_state] ?? MERGE_STATE.UNKNOWN!;
  const canMerge = pr.state === 'OPEN' && !pr.draft && pr.mergeable !== 'CONFLICTING' && ms.ok;
  const merge = async () => {
    setBusy(true);
    await act(async () => { await api('/api/prs/merge', 'POST', { project_id: pr.project_id, number: pr.number, method }); await refreshState(); }, t('#{n} 을(를) 병합했습니다', { n: pr.number }));
    setBusy(false);
  };
  const failing = pr.check_list.filter((c) => c.state === 'fail').length;
  const pending = pr.check_list.filter((c) => c.state === 'pending').length;
  return (
    <div ref={rowRef} className={`pr-row s-${pr.state.toLowerCase()}${open ? ' open' : ''}${focused ? ' focused' : ''}`}>
      <button type="button" className="pr-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`pr-state ${pr.state.toLowerCase()}${pr.draft ? ' draft' : ''}`}>{pr.draft && pr.state === 'OPEN' ? t('초안') : STATE[pr.state]}</span>
        <div className="pr-main">
          <div className="pr-t"><span className="muted mono">#{pr.number}</span> {pr.title}</div>
          <div className="pr-s muted">
            <span className="chip">{pr.project_name}</span>
            <span className="mono">{pr.base} ← {pr.head}</span>
            {pr.author && <span>· {pr.author}</span>}
            <span>· {ago(pr.merged_at ?? pr.updated_at, now)}</span>
            {team && <span className="pr-team" role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); go(`team-${team.id}`); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); go(`team-${team.id}`); } }}>{t('팀 「{name}」', { name: team.title || team.name })}</span>}
          </div>
        </div>
        <div className="pr-badges">
          {pr.checks !== 'none' && <span className={`pr-b ${pr.checks}`}>{CHECKS[pr.checks]}{pr.checks === 'fail' ? ` ${failing}` : pr.checks === 'pending' ? ` ${pending}` : ''}</span>}
          {pr.review && REVIEW[pr.review] && <span className={`pr-b r-${pr.review.toLowerCase()}`}>{REVIEW[pr.review]}</span>}
          <span className="pr-go" aria-hidden="true">{open ? '▴' : '▾'}</span>
        </div>
      </button>
      {open && (
        <div className="pr-body">
          <div className="pr-checks">
            <div className="pr-sub">{pr.check_list.length ? t('검사 {n}개', { n: pr.check_list.length }) : t('검사 없음')}</div>
            {pr.check_list.map((c, i) => (
              <div key={i} className={`pr-check ${c.state}`}>
                <span className="pr-ci" aria-label={c.state}>{CHECK_ICON[c.state]}</span>
                <span className="pr-cn">{c.name}</span>
                {c.url && <a href={c.url} target="_blank" rel="noreferrer">{t('로그 ↗')}</a>}
              </div>
            ))}
          </div>
          {pr.state === 'OPEN' && (
            <div className="pr-merge">
              <div className={`pr-ms ${ms.ok && pr.mergeable !== 'CONFLICTING' ? 'ok' : 'no'}`}>{pr.mergeable === 'CONFLICTING' ? t('충돌 · 병합 불가') : ms.text}{pr.review === 'CHANGES_REQUESTED' ? ` · ${t('수정 요청된 리뷰 있음')}` : ''}</div>
              <div className="row">
                <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label={t('병합 방식')} disabled={!canMerge}>
                  <option value="merge">{t('병합 커밋')}</option><option value="squash">{t('스쿼시')}</option><option value="rebase">{t('리베이스')}</option>
                </select>
                <ConfirmButton className="btn primary" label={busy ? t('병합 중…') : t('병합')} disabled={!canMerge || busy}
                  confirmLabel={`${t('{project} #{n} 을(를) {base} 에 병합할까요?', { project: pr.project_name, n: pr.number, base: pr.base })}${failing ? ` ${t('실패한 검사 {n}개가 있습니다.', { n: failing })}` : ''}${pending ? ` ${t('아직 도는 검사 {n}개가 있습니다.', { n: pending })}` : ''} ${t('되돌리려면 revert 가 필요합니다.')}`}
                  onConfirm={() => void merge()} />
                <a className="btn" href={pr.url} target="_blank" rel="noreferrer">GitHub ↗</a>
              </div>
            </div>
          )}
          {pr.state !== 'OPEN' && <div className="row"><a className="btn" href={pr.url} target="_blank" rel="noreferrer">{t('GitHub 에서 보기 ↗')}</a></div>}
        </div>
      )}
    </div>
  );
}

/** 저장소별 PR: 열린 것 먼저, 최근 3일 안에 병합·닫힌 것은 접어서 */
export function PrSection({ snap, focus }: { snap: StateSnapshot; focus?: string }) {
  const focusedPr = focus ? snap.prs.find((p) => prKey(p) === focus) : undefined;
  const [showClosed, setShowClosed] = useState(!!focusedPr && focusedPr.state !== 'OPEN');
  const [busy, setBusy] = useState(false);
  const open = snap.prs.filter((p) => p.state === 'OPEN');
  const closed = snap.prs.filter((p) => p.state !== 'OPEN');
  const errs = Object.entries(snap.prErrors);
  const refresh = async () => { setBusy(true); await act(() => api('/api/prs/refresh', 'POST', {})); await refreshState(); setBusy(false); };
  return (
    <section>
      <div className="section-h">
        <h2>PR <small className="muted">{t('열림 {n}', { n: open.length })}</small></h2>
        <div className="row">
          {closed.length > 0 && <button className="back" type="button" onClick={() => setShowClosed(!showClosed)}>{showClosed ? t('최근 병합·닫힘 숨기기') : t('최근 병합·닫힘 {n}', { n: closed.length })}</button>}
          <button className="back" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? t('불러오는 중…') : t('새로고침')}</button>
        </div>
      </div>
      {open.length || showClosed ? (
        <div className="pr-list">
          {open.map((p) => <PrRow key={p.url} pr={p} snap={snap} focused={prKey(p) === focus} />)}
          {showClosed && closed.map((p) => <PrRow key={p.url} pr={p} snap={snap} focused={prKey(p) === focus} />)}
        </div>
      ) : <div className="all-clear" style={{ color: 'var(--muted)', background: 'var(--surface-2)' }}>{t('열린 PR 이 없습니다. 2분마다 등록된 저장소에서 다시 읽습니다.')}</div>}
      {errs.length > 0 && <div className="muted small" style={{ marginTop: 6 }}>{errs.map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>}
    </section>
  );
}
