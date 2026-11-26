import { ConfirmButton } from './ui.tsx';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CleanItem, CleanScanView, GitCleanSummary } from '../../shared/types.ts';
import { act, api, refreshState, toast } from './store.ts';
import { t, tn, locale } from './i18n.ts';

type Resp = { summary: GitCleanSummary; scans: CleanScanView[]; lines?: string[] };

function Row({ it, on, toggle, disabled }: { it: CleanItem; on: boolean; toggle?: () => void; disabled?: boolean }) {
  return (
    <label className={`gc-row ${it.verdict}`}>
      {toggle ? <input type="checkbox" checked={on} onChange={toggle} disabled={disabled} /> : <span className="gc-nobox" />}
      <span className="gc-kind">{it.kind === 'worktree' ? 'worktree' : t('브랜치')}</span>
      <span className="gc-main">
        <span className="mono gc-label">{it.label}</span>{it.sub && <span className="muted small"> · {it.sub}</span>}
        <span className="gc-why">{it.why}{it.dirty?.length ? `: ${it.dirty.slice(0, 6).join(', ')}${it.dirty.length > 6 ? ' …' : ''}` : ''}</span>
      </span>
    </label>
  );
}

function Project({ s, local, onDone }: { s: CleanScanView; local: boolean; onDone: (r: Resp) => void }) {
  const removable = s.items.filter((i) => i.verdict === 'remove');
  const asks = s.items.filter((i) => i.verdict === 'ask');
  const keeps = s.items.filter((i) => i.verdict === 'keep');
  const [pick, setPick] = useState<Set<string>>(() => new Set(removable.map((i) => i.id)));
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  useEffect(() => { setPick(new Set(s.items.filter((i) => i.verdict === 'remove').map((i) => i.id))); setSure(false); }, [s]);
  const flip = (id: string) => { setSure(false); setPick((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const discard = asks.some((i) => pick.has(i.id));
  const ids = [...pick].filter((id) => s.items.some((i) => i.id === id && i.verdict !== 'keep'));
  const go = async () => {
    setBusy(true);
    const r = await act(() => api<Resp>('/api/git-clean/apply', 'POST', { project_id: s.project_id, ids, discard }));
    setBusy(false); setSure(false);
    if (r) { onDone(r); void refreshState(); }
  };
  if (!removable.length && !asks.length) return null;
  return (
    <section className="gc-proj">
      <h3>{s.project_name} <small className="muted">{t('기준 {base} · 정리 가능 {r} · 확인 필요 {a} · 남김 {k}', { base: s.base, r: removable.length, a: asks.length, k: keeps.length })}</small></h3>
      {removable.length > 0 && <div className="gc-g"><div className="gc-gh">{t('정리 가능')} <span className="muted small">{t('합쳐졌거나 원격에 있는 것 · 12시간 넘게 안 쓴 깨끗한 worktree')}</span></div>{removable.map((i) => <Row key={i.id} it={i} on={pick.has(i.id)} toggle={local ? () => flip(i.id) : undefined} />)}</div>}
      {asks.length > 0 && <div className="gc-g"><div className="gc-gh warn-t">{t('확인 필요')} <span className="muted small">{t('고르면 커밋 안 한 변경·어디에도 없는 커밋을 버립니다')}</span></div>{asks.map((i) => <Row key={i.id} it={i} on={pick.has(i.id)} toggle={local ? () => flip(i.id) : undefined} />)}</div>}
      {keeps.length > 0 && <details className="gc-g"><summary className="gc-gh muted">{t('남김 {n}', { n: keeps.length })} <span className="small">{t('쓰는 중·최근 사용·기준 브랜치 — 지우지 않음')}</span></summary>{keeps.map((i) => <Row key={i.id} it={i} on={false} />)}</details>}
      {local ? (
        <div className="gc-acts">
          {!sure
            ? <button className={`btn${discard ? ' danger' : ' primary'}`} type="button" disabled={!ids.length || busy} onClick={() => setSure(true)}>{t('선택한 {n}개 지우기', { n: ids.length })}{discard ? ` ${t('(변경 버림 포함)')}` : ''}</button>
            : <span className="confirm"><span>{discard ? t('확인 필요 항목의 변경·커밋까지 버립니다. 되돌릴 수 없습니다.') : t('지운 worktree 는 되돌릴 수 없습니다(브랜치는 원격·기준에 남아 있는 것만).')}</span><button className="btn danger" type="button" disabled={busy} onClick={() => void go()}>{busy ? t('지우는 중…') : t('확인')}</button><button className="btn" type="button" onClick={() => setSure(false)}>{t('취소')}</button></span>}
        </div>
      ) : <p className="muted small">{t('지우기는 맥에서만 할 수 있습니다.')}</p>}
    </section>
  );
}

/** 끝난 팀 옆 「worktree·브랜치 정리」: 서버가 살펴 둔 목록을 보고 골라서 지운다 */
export function GitCleanPanel({ local, onClose }: { local: boolean; onClose: () => void }) {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = (refresh: boolean) => { setLoading(true); void api<Resp>(`/api/git-clean${refresh ? '?refresh=1' : ''}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false)); };
  useEffect(() => load(true), []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', h); return () => removeEventListener('keydown', h); }, [onClose]);
  const shown = useMemo(() => d?.scans.filter((s) => s.items.some((i) => i.verdict !== 'keep')) ?? [], [d]);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={t('worktree·브랜치 정리')}>
        <div className="drawer-h">
          <div><h2>{t('worktree·브랜치 정리')}</h2><div className="drawer-sub muted">{t('등록된 저장소의 안 쓰는 worktree·로컬 브랜치 · 다른 Claude 세션이 쓰는 것은 「남김」')}</div></div>
          <div className="row"><button className="btn" type="button" disabled={loading} onClick={() => load(true)}>{loading ? t('살펴보는 중…') : t('다시 살펴보기')}</button><button className="btn" type="button" onClick={onClose}>{t('닫기')}</button></div>
        </div>
        <div className="drawer-b gc">
          {err && <p className="crit-t">{t('불러오지 못했습니다:')} {err}</p>}
          {!d && !err && <p className="muted">{t('살펴보는 중… (저장소마다 몇 초)')}</p>}
          {d?.lines && <details open className="gc-res"><summary>{t('방금 정리 결과')}</summary><pre>{d.lines.join('\n')}</pre></details>}
          {d && !shown.length && <p className="muted">{t('정리할 것이 없습니다.')}</p>}
          {shown.map((s) => <Project key={s.project_id} s={s} local={local} onDone={setD} />)}
          {d && <p className="muted small">{t('마지막 확인')} {d.summary.takenAt ? new Date(d.summary.takenAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '-'} · {t('10분마다 자동으로 살펴봅니다 · 브랜치를 지워도 원격 브랜치는 그대로입니다 · 지운 것의 변경은 패치로 남습니다')} · <a href="#finished/log" onClick={onClose}>{t('정리 기록 보기 →')}</a></p>}
        </div>
      </aside>
    </>,
    document.body,
  );
}

/** 끝난 팀의 worktree 정리 버튼: 두 번 눌러 확인 · 커밋 안 한 변경이 있으면 목록을 보여 주고 「버리고 지우기」를 한 번 더 */
/** 「팀 정리」로 끝난 팀에 보낼 수 있는 업무 팀 상태(서버 Orchestrator.CLOSABLE 과 같게) */
export const CLOSABLE = ['done', 'failed', 'paused', 'queued', 'waiting_human'];

/**
 * 「팀 정리」 — 팀 상세·팀 채널·끝난 팀 목록 어디서나 같은 동작:
 * 대화 종료 · worktree 는 변경을 패치로 남긴 뒤 삭제(브랜치는 남김) · 업무 팀 목록에서 빼 끝난 팀(보관)으로.
 */
export function TeamCleanButton({ teamId, hasWorktree, className = 'btn' }: { teamId: string; hasWorktree: boolean; className?: string }) {
  const close = () => act(async () => { await api(`/api/teams/${encodeURIComponent(teamId)}/close`, 'POST', {}); await refreshState(); }, t('팀을 정리했습니다 · 끝난 팀으로 옮김'));
  return (
    <ConfirmButton className={className} label={t('팀 정리')}
      confirmLabel={hasWorktree ? t('팀을 정리할까요? 대화를 끝내고, 작업 폴더는 변경을 패치로 남긴 뒤 지우고(브랜치는 남김), 업무 팀 목록에서 빼 끝난 팀으로 옮깁니다.') : t('팀을 정리할까요? 대화를 끝내고 업무 팀 목록에서 빼 끝난 팀으로 옮깁니다.')}
      onConfirm={() => void close()} />
  );
}
