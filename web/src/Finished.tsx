import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CleanupLogView, FinishedTeamView, StateSnapshot } from '../../shared/types.ts';
import { WorktreeCleanButton } from './GitClean.tsx';
import { api, toast } from './store.ts';
import { money } from './ui.tsx';
import { locale, t } from './i18n.ts';

const STATE: Record<string, string> = { done: t('완료'), failed: t('실패'), archived: t('보관') };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
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
      <div className="modal" role="dialog" aria-label={t('{path} 변경 내용', { path: title })}>
        <div className="drawer-h"><div><h2 className="mono modal-t">{title}</h2><div className="drawer-sub muted">{t('정리 때 남겨 둔 패치 · 되살리려면 저장소에서 git apply')}</div></div><button className="btn" type="button" onClick={onClose}>{t('닫기')}</button></div>
        <div className="modal-b">
          {text === null ? <div className="muted">{t('불러오는 중…')}</div> : !text ? <div className="muted">{t('내용이 없습니다.')}</div> : (
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
  useEffect(() => { const tid = setTimeout(() => setD(v), ms); return () => clearTimeout(tid); }, [v, ms]);
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
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('팀 이름·업무 검색')} aria-label={t('검색')} />
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label={t('상태')}><option value="">{t('전체 상태')}</option><option value="done">{t('완료')}</option><option value="failed">{t('실패')}</option><option value="archived">{t('보관(정리됨)')}</option></select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('저장소')}><option value="">{t('모든 저장소')}</option>{snap.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {items === null ? <p className="muted">{t('불러오는 중…')}</p> : !items.length ? <p className="muted">{t('해당하는 팀이 없습니다.')}</p> : (
        <div className="fin-list">
          {items.map((tm) => (
            <div key={tm.id} className={`fin-row ${tm.state}`}>
              <div className="fin-main">
                <a href={`#team-${tm.id}`} className="fin-name">{tm.title}</a>
                <div className="fin-meta">
                  <span className={`chip st-${tm.state}`}>{STATE[tm.state] ?? tm.state}</span>
                  {tm.project_name && <span>{tm.project_name}</span>}
                  <span className="mono">{when(tm.finished_at)}</span>
                  <span>{money(tm.cost_usd)}</span>
                  {tm.branch && <span className="mono muted">{tm.branch}</span>}
                  <span className="muted">{tm.worktree ? t('worktree 있음') : tm.patch ? t('정리됨 · 변경 패치 보관') : t('worktree 없음')}</span>
                </div>
                {tm.summary && <div className="fin-sum">{tm.summary}</div>}
              </div>
              {tm.worktree && (tm.state === 'done' || tm.state === 'failed') && local && <WorktreeCleanButton teamId={tm.id} />}
            </div>
          ))}
          {items.length < total && <button className="btn" type="button" onClick={() => load(items.length)}>{t('더 보기 ({n}/{total})', { n: items.length, total })}</button>}
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
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('저장소')}><option value="">{t('모든 저장소')}</option>{snap.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <span className="muted small">{t('화면·총괄·팀 버튼·자동(끝난 지 {n}일)으로 지운 worktree·브랜치', { n: snap.settings.autoCleanDays || '-' })}</span>
      </div>
      {items === null ? <p className="muted">{t('불러오는 중…')}</p> : !items.length ? <p className="muted">{t('아직 정리한 기록이 없습니다.')}</p> : (
        <div className="fin-list">
          {items.map((c) => (
            <div key={c.id} className="fin-row log">
              <div className="fin-main">
                <div className="fin-name"><span className="gc-kind">{c.kind === 'worktree' ? 'worktree' : t('브랜치')}</span> <span className="mono">{c.kind === 'worktree' ? home(c.target) : c.target}</span></div>
                <div className="fin-meta">
                  <span className="mono">{when(c.at)}</span>
                  <span className="chip">{c.by}</span>
                  {c.project_name && <span>{c.project_name}</span>}
                  {c.branch && c.kind === 'worktree' && <span className="mono muted">{c.branch}</span>}
                  {c.team_id && <a href={`#team-${c.team_id}`}>{t('팀 「{name}」', { name: c.team_name ?? c.team_id })}</a>}
                  {c.discarded && <span className="warn-t">{t('변경 버림 동의')}</span>}
                </div>
                {c.note && <div className="fin-sum">{c.note}</div>}
              </div>
              {c.patch && <button className="btn" type="button" onClick={() => setOpen(c)}>{t('변경 보기')}{c.patch_files ? ` (${c.patch_files})` : ''}</button>}
            </div>
          ))}
          {items.length < total && <button className="btn" type="button" onClick={() => load(items.length)}>{t('더 보기 ({n}/{total})', { n: items.length, total })}</button>}
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
        <h1>{t('끝난 팀')}</h1>
        <span className="muted">{t('완료 {done} · 실패 {failed} · 보관 {archived}', { done: c.done, failed: c.failed, archived: c.archived })}</span>
      </header>
      <nav className="set-tabs" aria-label={t('끝난 팀 구역')}>
        <a href="#finished" className={tab === 'teams' ? 'on' : ''}>{t('팀 목록')}</a>
        <a href="#finished/log" className={tab === 'log' ? 'on' : ''}>{t('정리 기록')}</a>
      </nav>
      {tab === 'teams' ? <TeamsTab snap={snap} /> : <LogTab snap={snap} />}
    </div>
  );
}
