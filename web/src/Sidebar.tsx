import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AuthLoginView, PrView, RepoView, StateSnapshot, TeamView } from '../../shared/types.ts';
import { GitCleanPanel } from './GitClean.tsx';
import { DOT_LABEL, dotOf, isActiveTask, isDoneTask, isStandingCh, nowCount, sideNote } from './chan.ts';
import { act, api, clock, conn, refreshState, route, useBox, type Route } from './store.ts';
import { locale, t, tn } from './i18n.ts';

const ZONE = { green: t('여유'), yellow: t('주의'), red: t('과부하') } as const;

function Bar({ v, y, r }: { v: number; y: number; r: number }) {
  const c = v > r ? 'var(--sb-crit)' : v >= y ? 'var(--sb-warn)' : 'var(--sb-good)';
  return <span className="sb-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(2, v))}%`, background: c }} /></span>;
}

/** 초기화 시각: 오늘이면 「14:00」, 내일이면 「내일」, 일주일 안이면 「수요일」, 그 뒤면 「12/3」 */
function resetLabel(iso: string): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86_400_000);
  if (diff <= 0) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff === 1) return t('내일');
  if (diff < 7) return d.toLocaleDateString(locale(), { weekday: 'long' });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** claude auth login 대행: 서버가 로그인 명령을 띄우고, 여기서 링크를 열어 로그인 → 코드가 보이면 붙여 넣기 */
function AuthModal({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState<AuthLoginView | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => { void api<AuthLoginView>('/api/auth/login').then(setV).catch(() => {}); }, []);
  useEffect(() => {
    if (v?.phase !== 'waiting') return;
    const iv = setInterval(() => { void api<AuthLoginView>('/api/auth/login').then((n) => { setV(n); if (n.phase === 'done') void refreshState(); }).catch(() => {}); }, 1000);
    return () => clearInterval(iv);
  }, [v?.phase]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', h); return () => removeEventListener('keydown', h); }, [onClose]);
  const start = () => act(async () => setV(await api<AuthLoginView>('/api/auth/login', 'POST', {})));
  const send = async () => { setSending(true); await act(async () => { setV(await api<AuthLoginView>('/api/auth/login/code', 'POST', { code })); setCode(''); }, t('코드를 보냈습니다')); setSending(false); };
  const cancel = () => act(async () => setV(await api<AuthLoginView>('/api/auth/login/cancel', 'POST', {})));
  const waiting = v?.phase === 'waiting';
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={t('Claude 재인증')}>
        <div className="drawer-h"><div><h2>{t('Claude 재인증')}</h2><div className="drawer-sub muted">{t('터미널의 claude auth login 과 같습니다 · 팀·총괄이 쓰는 로그인이 바뀝니다')}</div></div><div className="row"><button className="btn" type="button" onClick={onClose}>{t('닫기')}</button></div></div>
        <div className="drawer-b au">
          {v?.phase === 'done' && <p className="au-ok">{t('다시 로그인했습니다. 사용량·인증 표시가 곧 새로 고쳐집니다.')}</p>}
          {v?.phase === 'failed' && <p className="crit-t">{t('끝나지 않았습니다: {error}', { error: v.error ?? '' })}</p>}
          {!waiting && <p><button className="btn primary" type="button" onClick={() => void start()}>{v?.phase === 'done' ? t('한 번 더 로그인') : t('로그인 시작')}</button></p>}
          {waiting && (
            <ol className="au-steps">
              <li>{v.url ? <a className="btn primary" href={v.url} target="_blank" rel="noreferrer">{t('로그인 페이지 열기')}</a> : <span className="muted">{t('로그인 주소 받는 중…')}</span>} <span className="muted small">{t('맥에서는 브라우저가 저절로 열릴 수도 있습니다')}</span></li>
              <li>{t('열린 페이지에서 Claude 계정으로 로그인하고 「승인」을 누릅니다.')}</li>
              <li>
                {tn('맥 브라우저면 그대로 끝납니다. 휴대폰처럼 {b}가 화면에 보이면 복사해 여기에 붙여 넣으세요.', { b: <b>{t('인증 코드')}</b> })}
                <div className="au-code"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('인증 코드 붙여 넣기')} aria-label={t('인증 코드')} autoComplete="off" /><button className="btn" type="button" disabled={code.trim().length < 4 || sending} onClick={() => void send()}>{t('보내기')}</button></div>
              </li>
              <li className="muted small">{t('10분 안에 끝내지 않으면 저절로 멈춥니다')} · <button type="button" className="link-btn" onClick={() => void cancel()}>{t('취소')}</button></li>
            </ol>
          )}
          {v?.output && <details className="au-log"><summary className="muted small">{t('명령 출력')}</summary><pre>{v.output}</pre></details>}
        </div>
      </aside>
    </>,
    document.body,
  );
}

type DiagData = {
  cpu: number; mem: number; load: number; cores: number; ownShare: number;
  groups: { pid: number; label: string; detail: string; kind: string; cpu: number; share: number; rssMb: number; count: number }[];
  top: { pid: number; name: string; cpu: number; share: number; rssMb: number; etime: string; origin: string; command: string }[];
};
const KIND: Record<string, string> = { claude: 'Claude', team: t('Hivelane 팀'), hivelane: 'Hivelane', app: t('앱'), system: 'macOS', other: t('기타') };
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);
const etime = (e: string) => e.replace(/^(\d+)-/, t('{d}일 ', { d: '$1' })).replace(/^00:/, '').replace(/^0(\d)/, '$1');

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
      <aside className="drawer" aria-label={t('맥 리소스 상세')}>
        <div className="drawer-h"><div><h2>{t('맥 리소스 · 누가 쓰나')}</h2><div className="drawer-sub muted">{t('지금 이 순간 기준 · 코어 {n}개 전체를 100%로 환산', { n: d?.cores ?? '—' })}</div></div><div className="row"><button className="btn" type="button" onClick={load} disabled={!d}>{t('다시 재기')}</button><button className="btn" type="button" onClick={onClose}>{t('닫기')}</button></div></div>
        <div className="drawer-b">
          {err && <div className="muted">{t('불러오지 못했습니다: {err}', { err })}</div>}
          {!d && !err && <div className="muted">{t('재는 중…')}</div>}
          {d && (
            <>
              <div className="rs-sum">
                <div><small>CPU</small><b className={d.cpu > 85 ? 'crit-t' : d.cpu >= 70 ? 'warn-t' : ''}>{d.cpu}%</b><span className="rs-bar"><i style={{ width: `${d.cpu}%` }} /></span></div>
                <div><small>{t('메모리 압박')}</small><b className={d.mem > 85 ? 'crit-t' : d.mem >= 75 ? 'warn-t' : ''}>{d.mem}%</b><span className="rs-bar"><i style={{ width: `${d.mem}%` }} /></span></div>
                <div><small>{t('부하(load)')}</small><b>{d.load}</b><span className="muted small">{t('코어 {n}개 기준 {pct}%', { n: d.cores, pct: Math.round((d.load / d.cores) * 100) })}</span></div>
                <div><small>{t('Hivelane 몫')}</small><b>{d.ownShare}%</b><span className="muted small">{d.ownShare < 25 ? t('대부분 다른 프로그램') : t('Hivelane 팀이 큰 몫')}</span></div>
              </div>

              <h3 className="rs-h">{t('누가 쓰나')} <small className="muted">{t('비슷한 것끼리 묶음')}</small></h3>
              <div className="rs-groups">
                {d.groups.map((g) => (
                  <div key={g.pid} className={`rs-g k-${g.kind}`}>
                    <span className="rs-kind">{KIND[g.kind] ?? g.kind}</span>
                    <div className="rs-gm">
                      <div className="rs-gl"><b>{g.label}</b>{g.detail && <span className="muted mono"> {g.detail}</span>}</div>
                      <span className="rs-bar wide"><i style={{ width: `${Math.max(2, (g.share / max) * 100)}%` }} /></span>
                    </div>
                    <div className="rs-gn"><b>{g.share}%</b><span className="muted">{gb(g.rssMb)} · {t('{n}개', { n: g.count })}</span></div>
                  </div>
                ))}
              </div>

              <details className="rs-top">
                <summary>{t('프로세스 상위 {n}개 보기', { n: d.top.length })}</summary>
                <div className="rs-procs">
                  {d.top.map((p) => (
                    <div key={p.pid} className="rs-p" title={p.command}>
                      <div className="rs-pm"><b>{p.name}</b><span className="muted"> · {p.origin}</span></div>
                      <div className="rs-pn mono"><b>{p.share}%</b> <span className="muted">{gb(p.rssMb)} · {etime(p.etime)} · pid {p.pid}</span></div>
                    </div>
                  ))}
                </div>
              </details>
              <p className="muted small">{t('총괄에게 「CPU 왜 높아?」라고 물으면 같은 자료로 원인과 조치를 정리해 줍니다.')}</p>
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
  const pull = () => act(async () => { const x = await api<{ message: string }>(`/api/repos/${encodeURIComponent(r.project_id)}/pull`, 'POST', {}); await refreshState(); return x; }, t('{name}: 받았습니다', { name: r.project_name }));
  const tip = [r.path, r.remote ? t('원격: {label}', { label: r.remote.label }) : t('원격 저장소 없음(이 맥에만)'), r.branch ? `${t('브랜치 {branch}', { branch: r.branch })}${r.upstream ? ` ← ${r.upstream}` : t(' (원격 연결 없음)')}` : '', r.behind ? t('받을 것: 커밋 {c}개 · 파일 {f}개', { c: r.behind, f: r.incoming }) : t('받을 것 없음(최신)'), r.overlap.length ? `${t('겹침: 받을 파일 중 로컬에서 고친 파일 {n}개 → 받기가 거절될 수 있음', { n: r.overlap.length })}\n  ${r.overlap.join('\n  ')}` : '', r.ahead ? t('안 올린 내 커밋 {n}개', { n: r.ahead }) : '', r.dirty ? t('커밋 안 한 로컬 변경 파일 {n}개', { n: r.dirty }) : '', r.error ?? ''].filter(Boolean).join('\n');
  return (
    <div className="sb-item sb-repo" title={tip}>
      <span className="sb-name">{r.project_name}<span className="sb-branch">{r.branch ?? '?'}</span></span>
      {r.error ? <span className="sb-note t-pause">{t('오류')}</span> : <>
        {r.behind > 0 && <span className="sb-rb behind" aria-label={t('받을 파일 {f}개(커밋 {c}개)', { f: r.incoming, c: r.behind })}>↓{r.incoming}</span>}
        {r.overlap.length > 0 && <span className="sb-rb clash" aria-label={t('겹침 {n}개', { n: r.overlap.length })}>⚠{r.overlap.length}</span>}
        {r.ahead > 0 && <span className="sb-rb" aria-label={t('안 올린 커밋 {n}개', { n: r.ahead })}>↑{r.ahead}</span>}
        {r.dirty > 0 && <span className="sb-rb dim" aria-label={t('로컬 변경 {n}개', { n: r.dirty })}>✎{r.dirty}</span>}
      </>}
      {r.upstream && <button type="button" className={`sb-pull${r.behind > 0 ? ' on' : ''}`} disabled={r.pulling} onClick={() => void pull()} title={t('{up} → {path} ({branch}) 받기\n빨리 감기만 · 로컬 변경·커밋은 건드리지 않음', { up: r.upstream, path: r.path.replace(/^\/Users\/[^/]+/, '~'), branch: r.branch ?? '' })}>{r.pulling ? t('받는 중') : t('받기')}</button>}
    </div>
  );
}

const PR_CHECK: Record<string, { icon: string; cls: string; label: string }> = {
  pass: { icon: '✓', cls: 'ok', label: t('검사 통과') }, fail: { icon: '✕', cls: 'bad', label: t('검사 실패') }, pending: { icon: '●', cls: 'wait', label: t('검사 중') }, none: { icon: '', cls: '', label: t('검사 없음') },
};
const MERGE_OK = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BEHIND', 'UNKNOWN']);

/** 사이드바 PR 한 줄: 검사 상태 · 병합(두 번 눌러 확인) · 제목은 GitHub 로 */
function PrItem({ p, on = false }: { p: PrView; on?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!confirm) return; const to = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(to); }, [confirm]);
  const list = p.check_list ?? [];
  const fail = list.filter((c) => c.state === 'fail').length;
  const wait = list.filter((c) => c.state === 'pending').length;
  const ck = PR_CHECK[p.checks] ?? PR_CHECK.none!;
  const conflict = p.mergeable === 'CONFLICTING' || p.merge_state === 'DIRTY';
  const blocked = p.merge_state === 'BLOCKED';
  const canMerge = !p.draft && !conflict && MERGE_OK.has(p.merge_state ?? 'UNKNOWN');
  const why = p.draft ? t('초안이라 병합할 수 없음') : conflict ? t('충돌 · 병합 불가') : blocked ? t('막힘 · 리뷰·필수 검사 등 보호 규칙') : p.merge_state === 'BEHIND' ? t('기준 브랜치보다 뒤처짐') : t('병합 가능');
  const tip = [`${p.project_name} #${p.number} ${p.title}`, `${p.base} ← ${p.head}${p.author ? ` · ${p.author}` : ''}`, `${ck.label}${fail ? ` · ${t('실패 {n}', { n: fail })}` : ''}${wait ? ` · ${t('진행 중 {n}', { n: wait })}` : ''}`, ...list.slice(0, 8).map((c) => `  ${PR_CHECK[c.state === 'skip' ? 'none' : c.state]?.icon || '–'} ${c.name}`), p.review === 'APPROVED' ? t('리뷰 승인') : p.review === 'CHANGES_REQUESTED' ? t('수정 요청된 리뷰') : p.review === 'REVIEW_REQUIRED' ? t('리뷰 대기') : '', why].filter(Boolean).join('\n');
  const merge = async () => {
    setBusy(true);
    await act(async () => { await api('/api/prs/merge', 'POST', { project_id: p.project_id, number: p.number, method: 'merge' }); await refreshState(); }, t('#{n} 을(를) 병합했습니다', { n: p.number }));
    setBusy(false); setConfirm(false);
  };
  return (
    <div className={`sb-item sb-pri${on ? ' on' : ''}`} title={tip}>
      {ck.icon ? <span className={`sb-ck ${ck.cls}`} aria-label={ck.label}>{ck.icon}</span> : <span className={`sb-pr${p.draft ? ' draft' : ''}`}>{p.draft ? t('초안') : t('열림')}</span>}
      <a className="sb-name sb-prlink" href={`#prs/${p.project_id}:${p.number}`}>#{p.number} {p.title}</a>
      {conflict && <span className="sb-rb clash" aria-label={t('충돌')}>⚠</span>}
      {canMerge
        ? <button type="button" className={`sb-pull${confirm ? ' confirm' : ''}`} disabled={busy} onClick={() => (confirm ? void merge() : setConfirm(true))} title={confirm ? `${t('{base} 에 병합 커밋으로 병합합니다', { base: p.base })}${fail ? ` · ${t('실패한 검사 {n}개', { n: fail })}` : ''}${wait ? ` · ${t('진행 중 검사 {n}개', { n: wait })}` : ''}` : t('병합(두 번 눌러 확인)')}>{busy ? t('병합 중') : confirm ? t('확인?') : t('병합')}</button>
        : <span className="sb-note t-muted" title={why}>{p.draft ? t('초안') : conflict ? t('충돌') : blocked ? t('막힘') : ''}</span>}
    </div>
  );
}

function TeamItem({ tm, r, now }: { tm: TeamView; r: Route; now: number }) {
  const dot = dotOf(tm);
  const note = sideNote(tm, now);
  const on = r.name === 'team' && r.id === tm.id;
  const loud = tm.unread > 0 || dot === 'ask';
  return (
    <a href={`#team-${tm.id}`} className={`sb-item${on ? ' on' : ''}${loud ? ' loud' : ''}${dot === 'idle' ? ' dim' : ''}`} title={`${tm.title || tm.name} · ${DOT_LABEL[dot]}${tm.busy_note ? ` · ${tm.busy_note}` : ''}`}>
      <span className={`sdot ${dot}`} aria-label={DOT_LABEL[dot]} />
      <span className="sb-name">{tm.title || tm.name}</span>
      {note && (note.cls === 'b-ask' ? <span className="sb-badge ask">{note.text}</span> : <span className={`sb-note ${note.cls}`}>{note.text}</span>)}
      {tm.unread > 0 && dot !== 'ask' && <span className="sb-badge">{tm.unread}</span>}
    </a>
  );
}

export function Sidebar({ snap }: { snap: StateSnapshot }) {
  const r = useBox(route);
  const now = useBox(clock);
  const c = useBox(conn);
  const [showDone, setShowDone] = useState(() => { try { return localStorage.getItem('hl.done') === '1'; } catch { return false; } });
  const [diag, setDiag] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const gcN = snap.gitClean.remove + snap.gitClean.ask;
  const finTotal = snap.finishedCount.done + snap.finishedCount.failed + snap.finishedCount.archived;
  const toggleDone = () => { setShowDone(!showDone); try { localStorage.setItem('hl.done', showDone ? '0' : '1'); } catch { /* 저장 안 됨 */ } };
  const standing = snap.teams.filter(isStandingCh);
  const tasks = snap.teams.filter(isActiveTask).sort((a, b) => ({ waiting_human: 0, failed: 1, running: 2, paused: 3, queued: 4 } as Record<string, number>)[a.state]! - ({ waiting_human: 0, failed: 1, running: 2, paused: 3, queued: 4 } as Record<string, number>)[b.state]! || b.created_at.localeCompare(a.created_at));
  const done = snap.teams.filter(isDoneTask);
  const openPrs = snap.prs.filter((p) => p.state === 'OPEN');
  const { need, news } = nowCount(snap);
  const res = snap.resource;
  const e = snap.settings.engine;
  const usage = snap.usage;
  const usageTip = `${t('Claude 플랜 사용량')}${usage.plan ? ` (${usage.plan})` : ''} · ${usage.windows.map((w) => `${w.label} ${Math.round(w.pct)}%${w.resets_at ? ` · ${t('{when} 초기화', { when: new Date(w.resets_at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) })}` : ''}`).join(' / ')}${usage.takenAt ? ` · ${t('{time} 기준, 5분마다 갱신', { time: new Date(usage.takenAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })}` : ''}`;
  const nowOn = r.name === 'now' || r.name === 'home';
  const prFocus = r.name === 'prs' ? r.focus : undefined;
  const poPending = snap.proposals.filter((p) => p.status === 'pending').length;

  return (
    <nav className="sb" aria-label={t('채널')}>
      <div className="sb-top">
        <a href="#now" className="sb-logo" aria-label={t('Hivelane 지금 볼 것')}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><g strokeLinejoin="round" strokeWidth="1.6"><polygon points="7.6,4.2 10.9,6.1 10.9,9.9 7.6,11.8 4.3,9.9 4.3,6.1" fill="none" stroke="#7FC8C8" /><polygon points="16.4,4.2 19.7,6.1 19.7,9.9 16.4,11.8 13.1,9.9 13.1,6.1" fill="none" stroke="#7FC8C8" /><polygon points="12,11.8 15.3,13.7 15.3,17.5 12,19.4 8.7,17.5 8.7,13.7" fill="#F2B33D" stroke="#F2B33D" /></g></svg>
          Hivelane
        </a>
        {snap.access === 'remote' && <span className="sb-remote">{t('원격')}</span>}
        <a href="#settings" className={`sb-icon${r.name === 'settings' || r.name === 'templates' ? ' on' : ''}`} aria-label={t('설정')} title={t('설정 · 팀 템플릿 · 프로젝트 · 알림')}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
        </a>
      </div>

      <div className="sb-scroll">
        <a href="#now" className={`sb-now${nowOn ? ' on' : ''}${need ? ' need' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l4 4L20 5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t('지금 볼 것')}
          {need + news > 0 && <span className="sb-now-n">{need + news}</span>}
        </a>
        <a href="#po" className={`sb-item sb-po${r.name === 'po' ? ' on' : ''}${snap.poUnread || poPending ? ' loud' : ''}`}>
          <span className={`sdot ${snap.poBusy ? 'run' : 'idle'}`} aria-label={snap.poBusy ? t('생각 중') : t('대기')} />
          <span className="sb-name">{t('총괄')}</span>
          {poPending > 0 ? <span className="sb-badge ask">{t('제안 {n}', { n: poPending })}</span> : snap.poUnread > 0 ? <span className="sb-badge">{snap.poUnread}</span> : <span className={`sb-note ${snap.poBusy ? 't-run' : 't-muted'}`}>{snap.poBusy ? t('생각 중') : t('대기')}</span>}
        </a>

        <div className="sb-h">{t('직속 팀@목록')}<a href="#settings/standing" className="sb-add" aria-label={t('직속 팀 추가')} title={t('직속 팀 추가(설정 › 직속 팀)')}>＋</a></div>
        {standing.length ? standing.map((tm) => <TeamItem key={tm.id} tm={tm} r={r} now={now} />) : <div className="sb-empty">{t('없음 · 총괄에게 「직속팀 만들어줘」')}</div>}

        <div className="sb-h">{t('업무 팀@목록')}</div>
        {tasks.length ? tasks.map((tm) => <TeamItem key={tm.id} tm={tm} r={r} now={now} />) : <div className="sb-empty">{t('진행 중인 업무 없음')}</div>}
        {(done.length > 0 || gcN > 0 || finTotal > 0) && (
          <div className="sb-fin">
            <div className="sb-h sb-fin-h">
              <button type="button" className="sb-fin-t" onClick={toggleDone} aria-expanded={showDone}>
                <span className={`sb-chev${showDone ? ' open' : ''}`} aria-hidden="true">›</span>{t('끝난 팀')} <span className="sb-fin-n">{finTotal || done.length}</span>
              </button>
              {gcN > 0 && <button type="button" className="sb-clean" onClick={() => setCleanOpen(true)} title={t('정리 가능 {r} · 확인 필요 {a} — 안 쓰는 worktree·로컬 브랜치', { r: snap.gitClean.remove, a: snap.gitClean.ask })}>{t('정리')} <b>{gcN}</b></button>}
            </div>
            {showDone && (
              <div className="sb-fin-list">
                {done.slice(0, 20).map((tm) => <TeamItem key={tm.id} tm={tm} r={r} now={now} />)}
                {!done.length && <div className="sb-empty">{t('최근 끝난 팀 없음')}</div>}
                <a href="#finished" className={`sb-all${r.name === 'finished' ? ' on' : ''}`}>{t('전체 보기 ({n}) · 보관·정리 기록 ›', { n: finTotal })}</a>
              </div>
            )}
          </div>
        )}

      </div>

      <div className="sb-bottom">
        <a href="#scripts" className={`sb-item sb-po sb-scripts${r.name === 'scripts' ? ' on' : ''}`}>
          <span className={`sdot ${snap.scripts.some((s) => s.running_run_id) ? 'run' : 'idle'}`} />
          <span className="sb-name">{t('스크립트')}</span>
          {snap.scripts.some((s) => s.running_run_id) ? <span className="sb-note t-run">{t('실행 중 {n}', { n: snap.scripts.filter((s) => s.running_run_id).length })}</span> : <span className="sb-note t-muted">{snap.scripts.length || ''}</span>}
        </a>
        <div className="sb-h">{t('저장소 · PR')}<a href="#prs" className="sb-add sb-h-link" title={t('PR 전체(최근 병합·닫힘 포함)')}>{t('PR 전체')}</a><button type="button" className="sb-add" title={t('원격에서 새로 확인(fetch)')} onClick={() => void act(async () => { await api('/api/repos/refresh', 'POST', {}); await refreshState(); }, t('저장소 상태를 다시 확인했습니다'))}>↻</button></div>
        {snap.repos.length ? snap.repos.map((r) => (
          <div key={r.project_id} className="sb-repo-g">
            <RepoItem r={r} />
            {openPrs.filter((p) => p.project_id === r.project_id).map((p) => <PrItem key={p.url} p={p} on={prFocus === `${p.project_id}:${p.number}`} />)}
          </div>
        )) : <div className="sb-empty">{t('확인 중…')}</div>}
      </div>

      <button type="button" className="sb-res" onClick={() => setDiag(true)} title={`${ZONE[res.zone]} · ${t('무거운 명령 {r} 실행 · {w} 대기', { r: res.heavyRunning, w: res.heavyWaiting })} · ${c === 'down' ? t('서버 연결 끊김') : t('서버 연결됨')} — ${t('누르면 누가 쓰는지 보기')}`}>
        <span className="sb-row">
          <span className={`sb-zone ${res.zone}`}>{ZONE[res.zone]}</span>
          <span className="sb-k">CPU</span><Bar v={res.cpu} y={e.cpuY} r={e.cpuR} /><span className="mono">{Math.round(res.cpu)}%</span>
          <span className="sb-k">{t('메모리')}</span><Bar v={res.mem} y={e.memY} r={e.memR} /><span className="mono">{Math.round(res.mem)}%</span>
          {c === 'down' && <span className="sb-down" aria-label={t('서버 연결 끊김')}>●</span>}
        </span>
        {usage.available && (
          usage.windows.slice(0, 2).map((w, i) => (
            <span key={w.key} className="sb-row" title={usageTip}>
              <span className={`sb-zone tok${i ? ' ghost' : ''}`}>{i ? '' : t('토큰')}</span>
              {usage.windows.length > 1 && <span className="sb-k">{w.label}</span>}
              <Bar v={w.pct} y={80} r={95} />
              <span>{tn('{pct} 사용 중', { pct: <span className="mono">{Math.round(w.pct)}%</span> })}{w.resets_at && <span className="sb-k"> ({t('{when} 초기화', { when: resetLabel(w.resets_at) })})</span>}</span>
            </span>
          ))
        )}
      </button>
      {usage.login && (
        <div className="sb-auth">
          <span className={`sb-zone ${usage.login.loggedIn ? 'tok' : 'red'}`}>{t('인증')}</span>
          <span className="sb-k" title={usage.login.expiresAt ? t('{when} 로그인 만료 · 그 전에 재인증하면 연장', { when: new Date(usage.login.expiresAt).toLocaleString(locale()) }) : undefined}>
            {usage.login.loggedIn ? (usage.login.expiresAt ? t('로그인 {date} 만료', { date: `${new Date(usage.login.expiresAt).getMonth() + 1}/${new Date(usage.login.expiresAt).getDate()}` }) : t('로그인됨')) : t('로그인 필요')}
          </span>
          <button type="button" className="sb-authbtn" onClick={() => setAuthOpen(true)}>{t('재인증')}</button>
        </div>
      )}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      {cleanOpen && <GitCleanPanel local={snap.access === 'local'} onClose={() => setCleanOpen(false)} />}
      {diag && <ResourceModal onClose={() => setDiag(false)} />}
    </nav>
  );
}
