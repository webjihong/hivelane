import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrView, RepoView, StateSnapshot, TeamView } from '../../shared/types.ts';
import { DOT_LABEL, dotOf, isActiveTask, isDoneTask, isStandingCh, nowCount, sideNote } from './chan.ts';
import { act, api, clock, conn, refreshState, route, useBox, type Route } from './store.ts';

const ZONE = { green: '여유', yellow: '주의', red: '과부하' } as const;

function Bar({ v, y, r }: { v: number; y: number; r: number }) {
  const c = v > r ? 'var(--sb-crit)' : v >= y ? 'var(--sb-warn)' : 'var(--sb-good)';
  return <span className="sb-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(2, v))}%`, background: c }} /></span>;
}

type DiagData = {
  cpu: number; mem: number; load: number; cores: number; ownShare: number;
  groups: { pid: number; label: string; detail: string; kind: string; cpu: number; share: number; rssMb: number; count: number }[];
  top: { pid: number; name: string; cpu: number; share: number; rssMb: number; etime: string; origin: string; command: string }[];
};
const KIND: Record<string, string> = { claude: 'Claude', team: 'Hivelane 팀', hivelane: 'Hivelane', app: '앱', system: 'macOS', other: '기타' };
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);
const etime = (e: string) => e.replace(/^(\d+)-/, '$1일 ').replace(/^00:/, '').replace(/^0(\d)/, '$1');

function ResourceModal({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<DiagData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => { setD(null); void api<DiagData>('/api/system/diag').then(setD).catch((e) => setErr(e instanceof Error ? e.message : String(e))); };
  useEffect(load, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', h); return () => removeEventListener('keydown', h); }, [onClose]);
  const max = d ? Math.max(1, ...d.groups.map((g) => g.share)) : 1;
  // 사이드바(어두운 칸) 밖, 문서 맨 위에 띄운다
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="맥 리소스 상세">
        <div className="drawer-h"><div><h2>맥 리소스 · 누가 쓰나</h2><div className="drawer-sub muted">지금 이 순간 기준 · 코어 {d?.cores ?? '—'}개 전체를 100%로 환산</div></div><div className="row"><button className="btn" type="button" onClick={load} disabled={!d}>다시 재기</button><button className="btn" type="button" onClick={onClose}>닫기</button></div></div>
        <div className="drawer-b">
          {err && <div className="muted">불러오지 못했습니다: {err}</div>}
          {!d && !err && <div className="muted">재는 중…</div>}
          {d && (
            <>
              <div className="rs-sum">
                <div><small>CPU</small><b className={d.cpu > 85 ? 'crit-t' : d.cpu >= 70 ? 'warn-t' : ''}>{d.cpu}%</b><span className="rs-bar"><i style={{ width: `${d.cpu}%` }} /></span></div>
                <div><small>메모리 압박</small><b className={d.mem > 85 ? 'crit-t' : d.mem >= 75 ? 'warn-t' : ''}>{d.mem}%</b><span className="rs-bar"><i style={{ width: `${d.mem}%` }} /></span></div>
                <div><small>부하(load)</small><b>{d.load}</b><span className="muted small">코어 {d.cores}개 기준 {Math.round((d.load / d.cores) * 100)}%</span></div>
                <div><small>Hivelane 몫</small><b>{d.ownShare}%</b><span className="muted small">{d.ownShare < 25 ? '대부분 다른 프로그램' : 'Hivelane 팀이 큰 몫'}</span></div>
              </div>

              <h3 className="rs-h">누가 쓰나 <small className="muted">비슷한 것끼리 묶음</small></h3>
              <div className="rs-groups">
                {d.groups.map((g) => (
                  <div key={g.pid} className={`rs-g k-${g.kind}`}>
                    <span className="rs-kind">{KIND[g.kind] ?? g.kind}</span>
                    <div className="rs-gm">
                      <div className="rs-gl"><b>{g.label}</b>{g.detail && <span className="muted mono"> {g.detail}</span>}</div>
                      <span className="rs-bar wide"><i style={{ width: `${Math.max(2, (g.share / max) * 100)}%` }} /></span>
                    </div>
                    <div className="rs-gn"><b>{g.share}%</b><span className="muted">{gb(g.rssMb)} · {g.count}개</span></div>
                  </div>
                ))}
              </div>

              <details className="rs-top">
                <summary>프로세스 상위 {d.top.length}개 보기</summary>
                <div className="rs-procs">
                  {d.top.map((p) => (
                    <div key={p.pid} className="rs-p" title={p.command}>
                      <div className="rs-pm"><b>{p.name}</b><span className="muted"> · {p.origin}</span></div>
                      <div className="rs-pn mono"><b>{p.share}%</b> <span className="muted">{gb(p.rssMb)} · {etime(p.etime)} · pid {p.pid}</span></div>
                    </div>
                  ))}
                </div>
              </details>
              <p className="muted small">PO에게 「CPU 왜 높아?」라고 물으면 같은 자료로 원인과 조치를 정리해 줍니다.</p>
            </>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

function RepoItem({ r: raw }: { r: RepoView }) {
  // 서버가 옛 버전이어도 화면이 멈추지 않게 빠진 값은 기본값으로
  const r: RepoView = { ...raw, incoming: raw.incoming ?? 0, overlap: raw.overlap ?? [] };
  const pull = () => act(async () => { const x = await api<{ message: string }>(`/api/repos/${encodeURIComponent(r.project_id)}/pull`, 'POST', {}); await refreshState(); return x; }, `${r.project_name}: 받았습니다`);
  const tip = [r.path, r.branch ? `브랜치 ${r.branch}${r.upstream ? ` ← ${r.upstream}` : ' (원격 연결 없음)'}` : '', r.behind ? `받을 것: 커밋 ${r.behind}개 · 파일 ${r.incoming}개` : '받을 것 없음(최신)', r.overlap.length ? `겹침: 받을 파일 중 로컬에서 고친 파일 ${r.overlap.length}개 → 받기가 거절될 수 있음\n  ${r.overlap.join('\n  ')}` : '', r.ahead ? `안 올린 내 커밋 ${r.ahead}개` : '', r.dirty ? `커밋 안 한 로컬 변경 파일 ${r.dirty}개` : '', r.error ?? ''].filter(Boolean).join('\n');
  return (
    <div className="sb-item sb-repo" title={tip}>
      <span className="sb-name">{r.project_name}<span className="sb-branch">{r.branch ?? '?'}</span></span>
      {r.error ? <span className="sb-note t-pause">오류</span> : <>
        {r.behind > 0 && <span className="sb-rb behind" aria-label={`받을 파일 ${r.incoming}개(커밋 ${r.behind}개)`}>↓{r.incoming}</span>}
        {r.overlap.length > 0 && <span className="sb-rb clash" aria-label={`겹침 ${r.overlap.length}개`}>⚠{r.overlap.length}</span>}
        {r.ahead > 0 && <span className="sb-rb" aria-label={`안 올린 커밋 ${r.ahead}개`}>↑{r.ahead}</span>}
        {r.dirty > 0 && <span className="sb-rb dim" aria-label={`로컬 변경 ${r.dirty}개`}>✎{r.dirty}</span>}
      </>}
      {r.upstream && <button type="button" className={`sb-pull${r.behind > 0 ? ' on' : ''}`} disabled={r.pulling} onClick={() => void pull()} title={`${r.upstream} → ${r.path.replace(/^\/Users\/[^/]+/, '~')} (${r.branch}) 받기\n빨리 감기만 · 로컬 변경·커밋은 건드리지 않음`}>{r.pulling ? '받는 중' : '받기'}</button>}
    </div>
  );
}

const PR_CHECK: Record<string, { icon: string; cls: string; label: string }> = {
  pass: { icon: '✓', cls: 'ok', label: '검사 통과' }, fail: { icon: '✕', cls: 'bad', label: '검사 실패' }, pending: { icon: '●', cls: 'wait', label: '검사 중' }, none: { icon: '', cls: '', label: '검사 없음' },
};
const MERGE_OK = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BEHIND', 'UNKNOWN']);

/** 사이드바 PR 한 줄: 검사 상태 · 병합(두 번 눌러 확인) · 제목은 GitHub 로 */
function PrItem({ p, on = false }: { p: PrView; on?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(t); }, [confirm]);
  const list = p.check_list ?? [];
  const fail = list.filter((c) => c.state === 'fail').length;
  const wait = list.filter((c) => c.state === 'pending').length;
  const ck = PR_CHECK[p.checks] ?? PR_CHECK.none!;
  const conflict = p.mergeable === 'CONFLICTING' || p.merge_state === 'DIRTY';
  const blocked = p.merge_state === 'BLOCKED';
  const canMerge = !p.draft && !conflict && MERGE_OK.has(p.merge_state ?? 'UNKNOWN');
  const why = p.draft ? '초안이라 병합할 수 없음' : conflict ? '충돌 · 병합 불가' : blocked ? '막힘 · 리뷰·필수 검사 등 보호 규칙' : p.merge_state === 'BEHIND' ? '기준 브랜치보다 뒤처짐' : '병합 가능';
  const tip = [`${p.project_name} #${p.number} ${p.title}`, `${p.base} ← ${p.head}${p.author ? ` · ${p.author}` : ''}`, `${ck.label}${fail ? ` · 실패 ${fail}` : ''}${wait ? ` · 진행 중 ${wait}` : ''}`, ...list.slice(0, 8).map((c) => `  ${PR_CHECK[c.state === 'skip' ? 'none' : c.state]?.icon || '–'} ${c.name}`), p.review === 'APPROVED' ? '리뷰 승인' : p.review === 'CHANGES_REQUESTED' ? '수정 요청된 리뷰' : p.review === 'REVIEW_REQUIRED' ? '리뷰 대기' : '', why].filter(Boolean).join('\n');
  const merge = async () => {
    setBusy(true);
    await act(async () => { await api('/api/prs/merge', 'POST', { project_id: p.project_id, number: p.number, method: 'merge' }); await refreshState(); }, `#${p.number} 을(를) 병합했습니다`);
    setBusy(false); setConfirm(false);
  };
  return (
    <div className={`sb-item sb-pri${on ? ' on' : ''}`} title={tip}>
      {ck.icon ? <span className={`sb-ck ${ck.cls}`} aria-label={ck.label}>{ck.icon}</span> : <span className={`sb-pr${p.draft ? ' draft' : ''}`}>{p.draft ? '초안' : '열림'}</span>}
      <a className="sb-name sb-prlink" href={`#prs/${p.project_id}:${p.number}`}>#{p.number} {p.title}</a>
      {conflict && <span className="sb-rb clash" aria-label="충돌">⚠</span>}
      {canMerge
        ? <button type="button" className={`sb-pull${confirm ? ' confirm' : ''}`} disabled={busy} onClick={() => (confirm ? void merge() : setConfirm(true))} title={confirm ? `${p.base} 에 병합 커밋으로 병합합니다${fail ? ` · 실패한 검사 ${fail}개` : ''}${wait ? ` · 진행 중 검사 ${wait}개` : ''}` : `병합(두 번 눌러 확인)${blocked ? '' : ''}`}>{busy ? '병합 중' : confirm ? '확인?' : '병합'}</button>
        : <span className="sb-note t-muted" title={why}>{p.draft ? '초안' : conflict ? '충돌' : blocked ? '막힘' : ''}</span>}
    </div>
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
  const prFocus = r.name === 'prs' ? r.focus : undefined;
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

        <a href="#scripts" className={`sb-item sb-po${r.name === 'scripts' ? ' on' : ''}`}>
          <span className={`sdot ${snap.scripts.some((s) => s.running_run_id) ? 'run' : 'idle'}`} />
          <span className="sb-name">스크립트</span>
          {snap.scripts.some((s) => s.running_run_id) ? <span className="sb-note t-run">실행 중 {snap.scripts.filter((s) => s.running_run_id).length}</span> : <span className="sb-note t-muted">{snap.scripts.length || ''}</span>}
        </a>

        <div className="sb-h">직속 팀<a href="#settings" className="sb-add" aria-label="직속 팀 추가" title="직속 팀 추가(설정)">＋</a></div>
        {standing.length ? standing.map((t) => <TeamItem key={t.id} t={t} r={r} now={now} />) : <div className="sb-empty">없음 · PO에게 「직속팀 만들어줘」</div>}

        <div className="sb-h">업무 팀</div>
        {tasks.length ? tasks.map((t) => <TeamItem key={t.id} t={t} r={r} now={now} />) : <div className="sb-empty">진행 중인 업무 없음</div>}
        {done.length > 0 && <button type="button" className="sb-more" onClick={toggleDone}>{showDone ? '끝난 팀 접기' : `끝난 팀 ${done.length}`}</button>}
        {showDone && done.map((t) => <TeamItem key={t.id} t={t} r={r} now={now} />)}

      </div>

      <div className="sb-bottom">
        <div className="sb-h">저장소 · PR<a href="#prs" className="sb-add sb-h-link" title="PR 전체(최근 병합·닫힘 포함)">PR 전체</a><button type="button" className="sb-add" title="원격에서 새로 확인(fetch)" onClick={() => void act(async () => { await api('/api/repos/refresh', 'POST', {}); await refreshState(); }, '저장소 상태를 다시 확인했습니다')}>↻</button></div>
        {snap.repos.length ? snap.repos.map((r) => (
          <div key={r.project_id} className="sb-repo-g">
            <RepoItem r={r} />
            {openPrs.filter((p) => p.project_id === r.project_id).map((p) => <PrItem key={p.url} p={p} on={prFocus === `${p.project_id}:${p.number}`} />)}
          </div>
        )) : <div className="sb-empty">확인 중…</div>}
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
