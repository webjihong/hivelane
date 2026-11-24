import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CleanupLogView, FinishedTeamView, StateSnapshot } from '../../shared/types.ts';
import { WorktreeCleanButton } from './GitClean.tsx';
import { api, toast } from './store.ts';
import { money } from './ui.tsx';

const STATE: Record<string, string> = { done: '완료', failed: '실패', archived: '보관' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

/** 패치 보기: + 초록 · - 빨강 */
function PatchModal({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ patch: string }>(url).then((r) => { if (alive) setText(r.patch); }).catch((e: unknown) => { toast(e instanceof Error ? e.message : String(e), 'crit'); if (alive) setText(''); });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', key);
    return () => { alive = false; removeEventListener('keydown', key); };
  }, [url, onClose]);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-label={`${title} 변경 내용`}>
        <div className="drawer-h"><div><h2 className="mono modal-t">{title}</h2><div className="drawer-sub muted">정리 때 남겨 둔 패치 · 되살리려면 저장소에서 git apply</div></div><button className="btn" type="button" onClick={onClose}>닫기</button></div>
        <div className="modal-b">
          {text === null ? <div className="muted">불러오는 중…</div> : !text ? <div className="muted">내용이 없습니다.</div> : (
            <pre className="diff">{text.split('\n').map((l, i) => {
              const cls = l.startsWith('+++') || l.startsWith('---') ? 'dh' : l.startsWith('+') ? 'da' : l.startsWith('-') ? 'dd' : l.startsWith('@@') ? 'dc' : /^(diff |index |commit |Author:|Date:)/.test(l) ? 'dh' : '';
              return <span key={i} className={cls}>{l}{'\n'}</span>;
            })}</pre>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function TeamsTab({ snap }: { snap: StateSnapshot }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [project, setProject] = useState('');
  const [items, setItems] = useState<FinishedTeamView[] | null>(null);
  const [total, setTotal] = useState(0);
  const dq = useDebounced(q, 300);
  const local = snap.access === 'local';
  const load = useCallback((offset: number) => {
    const qs = new URLSearchParams({ q: dq, state, project, offset: String(offset), limit: '50' });
    void api<{ items: FinishedTeamView[]; total: number }>(`/api/finished-teams?${qs}`).then((r) => { setItems((cur) => (offset ? [...(cur ?? []), ...r.items] : r.items)); setTotal(r.total); }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'crit'));
  }, [dq, state, project]);
  useEffect(() => load(0), [load, snap.finishedCount.archived, snap.finishedCount.done, snap.finishedCount.failed]);
  return (
    <>
      <div className="fin-filter">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="팀 이름·업무 검색" aria-label="검색" />
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="상태"><option value="">전체 상태</option><option value="done">완료</option><option value="failed">실패</option><option value="archived">보관(정리됨)</option></select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="저장소"><option value="">모든 저장소</option>{snap.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {items === null ? <p className="muted">불러오는 중…</p> : !items.length ? <p className="muted">해당하는 팀이 없습니다.</p> : (
        <div className="fin-list">
          {items.map((t) => (
            <div key={t.id} className={`fin-row ${t.state}`}>
              <div className="fin-main">
                <a href={`#team-${t.id}`} className="fin-name">{t.title}</a>
                <div className="fin-meta">
                  <span className={`chip st-${t.state}`}>{STATE[t.state] ?? t.state}</span>
                  {t.project_name && <span>{t.project_name}</span>}
                  <span className="mono">{when(t.finished_at)}</span>
                  <span>{money(t.cost_usd)}</span>
                  {t.branch && <span className="mono muted">{t.branch}</span>}
                  <span className="muted">{t.worktree ? 'worktree 있음' : t.patch ? '정리됨 · 변경 패치 보관' : 'worktree 없음'}</span>
                </div>
                {t.summary && <div className="fin-sum">{t.summary}</div>}
              </div>
              {t.worktree && (t.state === 'done' || t.state === 'failed') && local && <WorktreeCleanButton teamId={t.id} />}
            </div>
          ))}
          {items.length < total && <button className="btn" type="button" onClick={() => load(items.length)}>더 보기 ({items.length}/{total})</button>}
        </div>
      )}
    </>
  );
}

function LogTab({ snap }: { snap: StateSnapshot }) {
  const [project, setProject] = useState('');
  const [items, setItems] = useState<CleanupLogView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<CleanupLogView | null>(null);
  const load = useCallback((offset: number) => {
    const qs = new URLSearchParams({ project, offset: String(offset), limit: '50' });
    void api<{ items: CleanupLogView[]; total: number }>(`/api/cleanup-log?${qs}`).then((r) => { setItems((cur) => (offset ? [...(cur ?? []), ...r.items] : r.items)); setTotal(r.total); }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'crit'));
  }, [project]);
  useEffect(() => load(0), [load, snap.gitClean.takenAt, snap.finishedCount.archived]);
  return (
    <>
      <div className="fin-filter">
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="저장소"><option value="">모든 저장소</option>{snap.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <span className="muted small">화면·총괄·팀 버튼·자동(끝난 지 {snap.settings.autoCleanDays || '-'}일)으로 지운 worktree·브랜치</span>
      </div>
      {items === null ? <p className="muted">불러오는 중…</p> : !items.length ? <p className="muted">아직 정리한 기록이 없습니다.</p> : (
        <div className="fin-list">
          {items.map((c) => (
            <div key={c.id} className="fin-row log">
              <div className="fin-main">
                <div className="fin-name"><span className="gc-kind">{c.kind === 'worktree' ? 'worktree' : '브랜치'}</span> <span className="mono">{c.kind === 'worktree' ? home(c.target) : c.target}</span></div>
                <div className="fin-meta">
                  <span className="mono">{when(c.at)}</span>
                  <span className="chip">{c.by}</span>
                  {c.project_name && <span>{c.project_name}</span>}
                  {c.branch && c.kind === 'worktree' && <span className="mono muted">{c.branch}</span>}
                  {c.team_id && <a href={`#team-${c.team_id}`}>팀 「{c.team_name ?? c.team_id}」</a>}
                  {c.discarded && <span className="warn-t">변경 버림 동의</span>}
                </div>
                {c.note && <div className="fin-sum">{c.note}</div>}
              </div>
              {c.patch && <button className="btn" type="button" onClick={() => setOpen(c)}>변경 보기{c.patch_files ? ` (${c.patch_files})` : ''}</button>}
            </div>
          ))}
          {items.length < total && <button className="btn" type="button" onClick={() => load(items.length)}>더 보기 ({items.length}/{total})</button>}
        </div>
      )}
      {open && <PatchModal title={open.kind === 'worktree' ? home(open.target) : open.target} url={`/api/cleanup-log/${open.id}/patch`} onClose={() => setOpen(null)} />}
    </>
  );
}

/** 끝난 팀 전체(보관 포함) · 정리 기록 */
export function Finished({ snap, tab }: { snap: StateSnapshot; tab: 'teams' | 'log' }) {
  const c = snap.finishedCount;
  return (
    <div className="fin">
      <header className="fin-h">
        <h1>끝난 팀</h1>
        <span className="muted">완료 {c.done} · 실패 {c.failed} · 보관 {c.archived}</span>
      </header>
      <nav className="set-tabs" aria-label="끝난 팀 구역">
        <a href="#finished" className={tab === 'teams' ? 'on' : ''}>팀 목록</a>
        <a href="#finished/log" className={tab === 'log' ? 'on' : ''}>정리 기록</a>
      </nav>
      {tab === 'teams' ? <TeamsTab snap={snap} /> : <LogTab snap={snap} />}
    </div>
  );
}
