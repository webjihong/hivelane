import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CleanItem, CleanScanView, GitCleanSummary } from '../../shared/types.ts';
import { act, api, refreshState } from './store.ts';

type Resp = { summary: GitCleanSummary; scans: CleanScanView[]; lines?: string[] };

function Row({ it, on, toggle, disabled }: { it: CleanItem; on: boolean; toggle?: () => void; disabled?: boolean }) {
  return (
    <label className={`gc-row ${it.verdict}`}>
      {toggle ? <input type="checkbox" checked={on} onChange={toggle} disabled={disabled} /> : <span className="gc-nobox" />}
      <span className="gc-kind">{it.kind === 'worktree' ? 'worktree' : '브랜치'}</span>
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
      <h3>{s.project_name} <small className="muted">기준 {s.base} · 정리 가능 {removable.length} · 확인 필요 {asks.length} · 남김 {keeps.length}</small></h3>
      {removable.length > 0 && <div className="gc-g"><div className="gc-gh">정리 가능 <span className="muted small">합쳐졌거나 원격에 있는 것 · 12시간 넘게 안 쓴 깨끗한 worktree</span></div>{removable.map((i) => <Row key={i.id} it={i} on={pick.has(i.id)} toggle={local ? () => flip(i.id) : undefined} />)}</div>}
      {asks.length > 0 && <div className="gc-g"><div className="gc-gh warn-t">확인 필요 <span className="muted small">고르면 커밋 안 한 변경·어디에도 없는 커밋을 버립니다</span></div>{asks.map((i) => <Row key={i.id} it={i} on={pick.has(i.id)} toggle={local ? () => flip(i.id) : undefined} />)}</div>}
      {keeps.length > 0 && <details className="gc-g"><summary className="gc-gh muted">남김 {keeps.length} <span className="small">쓰는 중·최근 사용·기준 브랜치 — 지우지 않음</span></summary>{keeps.map((i) => <Row key={i.id} it={i} on={false} />)}</details>}
      {local ? (
        <div className="gc-acts">
          {!sure
            ? <button className={`btn${discard ? ' danger' : ' primary'}`} type="button" disabled={!ids.length || busy} onClick={() => setSure(true)}>선택한 {ids.length}개 지우기{discard ? ' (변경 버림 포함)' : ''}</button>
            : <span className="confirm"><span>{discard ? '확인 필요 항목의 변경·커밋까지 버립니다. 되돌릴 수 없습니다.' : '지운 worktree 는 되돌릴 수 없습니다(브랜치는 원격·기준에 남아 있는 것만).'}</span><button className="btn danger" type="button" disabled={busy} onClick={() => void go()}>{busy ? '지우는 중…' : '확인'}</button><button className="btn" type="button" onClick={() => setSure(false)}>취소</button></span>}
        </div>
      ) : <p className="muted small">지우기는 맥에서만 할 수 있습니다.</p>}
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
      <aside className="drawer" aria-label="worktree·브랜치 정리">
        <div className="drawer-h">
          <div><h2>worktree·브랜치 정리</h2><div className="drawer-sub muted">등록된 저장소의 안 쓰는 worktree·로컬 브랜치 · 다른 Claude 세션이 쓰는 것은 「남김」</div></div>
          <div className="row"><button className="btn" type="button" disabled={loading} onClick={() => load(true)}>{loading ? '살펴보는 중…' : '다시 살펴보기'}</button><button className="btn" type="button" onClick={onClose}>닫기</button></div>
        </div>
        <div className="drawer-b gc">
          {err && <p className="crit-t">불러오지 못했습니다: {err}</p>}
          {!d && !err && <p className="muted">살펴보는 중… (저장소마다 몇 초)</p>}
          {d?.lines && <details open className="gc-res"><summary>방금 정리 결과</summary><pre>{d.lines.join('\n')}</pre></details>}
          {d && !shown.length && <p className="muted">정리할 것이 없습니다.</p>}
          {shown.map((s) => <Project key={s.project_id} s={s} local={local} onDone={setD} />)}
          {d && <p className="muted small">마지막 확인 {d.summary.takenAt ? new Date(d.summary.takenAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-'} · 10분마다 자동으로 살펴봅니다 · 브랜치를 지워도 원격 브랜치는 그대로입니다</p>}
        </div>
      </aside>
    </>,
    document.body,
  );
}
