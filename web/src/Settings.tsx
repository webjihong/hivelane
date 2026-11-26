import { lang, locale, setLang, t, tn } from './i18n.ts';
import { useEffect, useState, type ReactNode } from 'react';
import type { EngineSettings, Model, OllamaView, Project, SearchStatusView, StorageView, Settings as SettingsT, StateSnapshot, TeamView } from '../../shared/types.ts';
import { act, api, isDesktopApp, refreshState, toast } from './store.ts';
import { BackupSection } from './Backup.tsx';
import { AccountsSection } from './Accounts.tsx';
import { AREAS, FONTS, SCALES, THEMES, TOKENS, allThemes, applyPrefs, currentTokens, loadPrefs, savePrefs, varsFromTokens, type AreaKey, type Theme, type UiPrefs } from './themes.ts';
import { ConfirmButton, Section, hhmm } from './ui.tsx';

type SettingsPatch = Partial<Omit<SettingsT, 'engine' | 'embedding'>> & { engine?: Partial<EngineSettings>; embedding?: Partial<SettingsT['embedding']> };
const saveSettings = (patch: SettingsPatch, ok = t('저장했습니다')) => act(async () => { await api('/api/settings', 'PUT', patch); await refreshState(); return true; }, ok);

function Row({ label, sub, htmlFor, children }: { label: string; sub?: string; htmlFor?: string; children: ReactNode }) {
  return <div className="set-row"><label htmlFor={htmlFor}>{label}{sub && <small>{sub}</small>}</label><span className="set-v">{children}</span></div>;
}

function NumField({ id, value, unit, disabled, onSave, step }: { id: string; value: number; unit: string; disabled: boolean; step?: number; onSave: (v: number) => Promise<unknown> }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = async () => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n)) { setV(String(value)); return; }
    if (n === value) return;
    const r = await onSave(n);
    if (r === undefined) setV(String(value));
  };
  return <><input className="num" type="number" id={id} step={step ?? 1} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /> <span className="muted small">{unit}</span></>;
}

/** 비우면 무제한(null) */
function BudgetField({ id, value, disabled, onSave }: { id: string; value: number | null; disabled: boolean; onSave: (v: number | null) => Promise<unknown> }) {
  const show = (x: number | null) => (x == null ? '' : String(x));
  const [v, setV] = useState(show(value));
  useEffect(() => setV(show(value)), [value]);
  const commit = async () => {
    const n = v.trim() === '' ? null : Number(v);
    if (n !== null && (!Number.isFinite(n) || n <= 0)) { setV(show(value)); return; }
    if (n === value) return;
    const r = await onSave(n);
    if (r === undefined) setV(show(value));
  };
  return <><input className="num" type="number" id={id} step={0.5} min={0} placeholder={t('무제한')} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /> <span className="muted small">$</span></>;
}

const ENGINE_ROWS: [keyof EngineSettings, string, string, string][] = [
  ['cpuY', t('CPU 노랑'), t('이 이상 지속되면 새 팀 시작 안 함'), '%'],
  ['cpuR', t('CPU 빨강'), t('넘으면 낮은 우선순위 팀부터 멈춤'), '%'],
  ['memY', t('메모리 노랑'), '', '%'],
  ['memR', t('메모리 빨강'), '', '%'],
  ['memHard', t('메모리 한계'), t('「멈추지 않음」 팀도 멈춤'), '%'],
  ['sustainSec', t('구간 판정 지속'), t('이 시간 동안 이어져야 구간을 바꿈'), t('초')],
  ['resumeSec', t('재개 대기'), t('초록이 이만큼 유지되면 하나씩 재개'), t('초')],
  ['hardPauseSec', t('강한 멈춤까지'), t('빨강이 이만큼 이어지면 프로세스 정지'), t('초')],
  ['pauseEverySec', t('멈춤 간격'), t('빨강에서 팀을 하나씩 멈추는 간격'), t('초')],
  ['stallMin', t('정체 판단'), t('활동이 없으면 총괄을 깨움'), t('분')],
  ['beatSec', t('직속 팀 생존 확인 간격'), t('무응답이면 되살리기 시작'), t('초')],
];
const CONC_ROWS: [keyof EngineSettings, string, string, string][] = [
  ['cap', t('동시 업무 팀 상한'), t('직속 팀은 세지 않음'), t('개')],
  ['slotsGreen', t('무거운 명령 자리 (초록)'), 'jest·vitest·tsc·build', t('개')],
  ['slotsYellow', t('무거운 명령 자리 (노랑)'), '', t('개')],
];

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/* ---------- 프로젝트 ---------- */
interface RemoteRef { name: string; url: string; web: string | null; label: string }
interface RepoInfo { root: string; name: string; baseRef: string; memoryPaths: string[]; hasNode: boolean; remote: RemoteRef | null }

/** 연결된 원격 저장소 한 줄: 있으면 링크, 없으면 「이 맥에만」 */
function RemoteLine({ remote }: { remote: RemoteRef | null | undefined }) {
  if (remote === undefined) return null;
  if (!remote) return <span className="muted small">{tn('원격 저장소: {b} — 이 맥에만 있는 저장소입니다. 팀 작업·diff 는 되고, PR·받기는 원격(GitHub 등)이 있어야 합니다.', { b: <b>{t('연결 안 됨')}</b> })}</span>;
  return <span className="small">{t('연동된 원격 저장소({name}):', { name: remote.name })} {remote.web ? <a href={remote.web} target="_blank" rel="noreferrer" className="mono">{remote.label}</a> : <span className="mono">{remote.label}</span>}</span>;
}

const DEPS_OPTS: [Project['deps_strategy'], string][] = [
  ['symlink', t('원래 폴더 것을 연결해 같이 쓰기 (권장)')],
  ['install', t('팀마다 새로 설치하기')],
  ['none', t('아무것도 안 하기')],
];
/** 고른 방식이 실제로 무엇을 하는지 */
const DEPS_EXPLAIN: Record<Project['deps_strategy'], string> = {
  symlink: t('팀이 일할 복사본 폴더에 원래 폴더의 node_modules 를 바로가기로 연결합니다. 설치 시간·추가 용량이 없습니다. 원래 폴더에서 npm install 을 해 둬야 하고, 팀이 package-lock 을 바꾼 하위 폴더만 따로 설치합니다.'),
  install: t('팀마다 복사본 폴더에서 npm ci 로 새로 설치합니다. 원래 폴더와 완전히 분리되지만 팀마다 몇 분씩 걸리고 수백 MB 씩 더 씁니다.'),
  none: t('패키지를 준비하지 않습니다. Node(JavaScript) 프로젝트가 아니거나, 팀이 테스트·빌드를 돌리지 않을 때 고릅니다.'),
};
const HELP = {
  name: t('목록과 총괄 대화에서 부를 이름'),
  base: t('팀이 일을 시작할 때 출발점이 되는 브랜치 · 보통 main, 원격이 있으면 origin/main·origin/dev'),
  deps: t('팀은 원래 폴더가 아니라 따로 복사한 폴더에서 일합니다. 그 복사본에 설치된 패키지(node_modules)를 어떻게 마련할지 고릅니다'),
  tpl: t('총괄이 이 저장소에 팀을 꾸릴 때 먼저 고르는 팀 구성 · 팀마다 바꿀 수 있음'),
  mem: t('이 폴더에서 Claude Code 를 써 왔다면 그 메모리(MEMORY.md)를 팀이 먼저 읽습니다'),
};

function ProjectNew({ snap }: { snap: StateSnapshot }) {
  const [path, setPath] = useState('');
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [name, setName] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [deps, setDeps] = useState<Project['deps_strategy']>('symlink');
  const [tpl, setTpl] = useState('tpl-dev');
  const [busy, setBusy] = useState(false);
  const [notGit, setNotGit] = useState<string | null>(null);
  const [linkNow, setLinkNow] = useState(false);
  /** git 저장소인지 확인 · 아니면 「git 시작하기」를 보여 준다 */
  const check = async (p: string) => {
    setBusy(true); setNotGit(null);
    const r = await act(() => api<RepoInfo | { notGit: true; path: string }>('/api/projects/inspect', 'POST', { path: p }));
    setBusy(false);
    if (!r) return;
    if ('notGit' in r) { setNotGit(r.path); return; }
    setInfo(r); setName(r.name); setBaseRef(r.baseRef); setDeps(r.hasNode ? 'symlink' : 'none');
  };
  const inspect = () => check(path.trim());
  const gitInit = async () => {
    if (!notGit) return;
    setBusy(true);
    const r = await act(() => api<RepoInfo>('/api/projects/git-init', 'POST', { path: notGit }), t('git 을 시작했습니다(첫 커밋 완료)'));
    setBusy(false);
    if (r) { setNotGit(null); setInfo(r); setName(r.name); setBaseRef(r.baseRef); setDeps(r.hasNode ? 'symlink' : 'none'); }
  };
  /** Finder 로 폴더 고르기 → 경로를 채우고 바로 확인 */
  const pick = async () => {
    setBusy(true);
    const r = await act(() => api<{ path: string | null }>('/api/pick-folder', 'POST', { prompt: t('Hivelane 에 등록할 git 저장소 폴더를 고르세요') }));
    setBusy(false);
    if (!r?.path) return;
    setPath(r.path); setInfo(null);
    await check(r.path);
  };
  const add = async () => {
    if (!info) return;
    setBusy(true);
    const r = await act(() => api<Project>('/api/projects', 'POST', { path: info.root, name: name.trim() || undefined, base_ref: baseRef.trim() || undefined, deps_strategy: deps, default_template_id: tpl || null }), t('프로젝트를 등록했습니다'));
    setBusy(false);
    if (r) { setInfo(null); setPath(''); await refreshState(); }
  };
  return (
    <div className="sub-panel">
      <h4>{t('새 프로젝트 등록')}</h4>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void inspect(); }}>
        <input value={path} onChange={(e) => { setPath(e.target.value); setInfo(null); setNotGit(null); }} placeholder={t('저장소 경로 (예: ~/code/my-app)')} aria-label={t('저장소 경로')} />
        <button className="btn" type="button" disabled={busy} onClick={() => void pick()} title={t('맥 화면에 Finder 폴더 고르기 창이 뜹니다')}>{t('Finder에서 고르기')}</button>
        <button className="btn" type="submit" disabled={!path.trim() || busy}>{t('확인')}</button>
      </form>
      {notGit && (
        <div className="rg warn small">
          <div>
            <b>{t('git 저장소가 아닙니다')}</b> · <span className="mono">{notGit}</span><br />
            {tn('Hivelane 은 git 으로 팀마다 따로 작업하고 바뀐 것을 셉니다. 여기서 git 을 시작하면 기본 {gi}(node_modules·.env·빌드 결과 등 제외)를 만들고 지금 상태로 첫 커밋을 합니다. 폴더 안 파일은 그대로이고 {git} 폴더가 생깁니다. GitHub 원격은 없어도 됩니다.', { gi: <code className="mono">.gitignore</code>, git: <code className="mono">.git</code> })}
            <div className="row" style={{ marginTop: 8 }}><button className="btn primary" type="button" disabled={busy} onClick={() => void gitInit()}>{busy ? t('시작하는 중…') : t('여기서 git 시작하기')}</button><button className="btn" type="button" onClick={() => setNotGit(null)}>{t('취소')}</button></div>
          </div>
        </div>
      )}
      {info && (
        <div className="form-grid pj-new">
          <div className="wide pj-sum">
            <b>{t('이 폴더를 프로젝트로 등록합니다')}</b>
            <span className="small">{t('로컬 폴더:')} <span className="mono">{info.root}</span></span>
            <RemoteLine remote={info.remote} />
            {!info.remote && !linkNow && <span><button className="btn" type="button" onClick={() => setLinkNow(true)}>{t('지금 원격 저장소 연결하기')}</button> <span className="muted small">{t('GitHub 에 새로 만들거나 이미 있는 저장소 주소를 연결 · 나중에 해도 됩니다')}</span></span>}
            {!info.remote && linkNow && <RemoteLink p={{ name: info.name, path: info.root }} onDone={() => { setLinkNow(false); void check(info.root); }} />}
            <span className="muted small">{t('Claude Code 메모리:')} {info.memoryPaths.length ? <span className="mono">{info.memoryPaths.join(', ')}</span> : t('없음')} — {HELP.mem}</span>
          </div>
          <label>{t('이름')} <small className="muted">{HELP.name}</small><input className="txt" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
          <label>{t('기준 브랜치')} <small className="muted">{HELP.base}</small><input className="txt mono" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} /></label>
          <label>{t('팀 작업 폴더의 패키지')} <small className="muted">{HELP.deps}</small>
            <select value={deps} onChange={(e) => setDeps(e.target.value as Project['deps_strategy'])}>
              {DEPS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <small className="dep-x">{DEPS_EXPLAIN[deps]}{!info.hasNode && deps !== 'none' ? ` · ${t('이 폴더엔 package.json 이 없어 「아무것도 안 하기」를 권합니다')}` : ''}</small>
          </label>
          <label>{t('기본 팀 구성')} <small className="muted">{HELP.tpl}</small>
            <select value={tpl} onChange={(e) => setTpl(e.target.value)}>{snap.templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select>
          </label>
          <div className="wide muted small">{t('git 권한(팀의 커밋·푸시 허용)과 막을 명령은 등록한 뒤 「수정」에서 정합니다. 처음엔 커밋·푸시가 막혀 있습니다.')}</div>
          <div className="row"><button className="btn primary" type="button" disabled={busy} onClick={() => void add()}>{t('등록')}</button><button className="btn" type="button" onClick={() => setInfo(null)}>{t('취소')}</button></div>
        </div>
      )}
    </div>
  );
}

/** 원격이 없는 프로젝트: GitHub 에 새로 만들기 또는 기존 주소 연결 */
function RemoteLink({ p, onDone }: { p: { id?: string; name: string; path?: string }; onDone: () => void }) {
  const [mode, setMode] = useState<'github' | 'url'>('github');
  const [accounts, setAccounts] = useState<{ login: string; active: boolean }[] | null | undefined>(undefined);
  const [account, setAccount] = useState('');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(p.name.replace(/[^\w.-]+/g, '-'));
  const [vis, setVis] = useState<'private' | 'public'>('private');
  const [url, setUrl] = useState('');
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ accounts: { login: string; active: boolean }[] | null }>('/api/github/accounts').then((r) => { setAccounts(r.accounts); const a = r.accounts?.find((x) => x.active) ?? r.accounts?.[0]; if (a) { setAccount(a.login); setOwner(a.login); } }).catch(() => setAccounts(null)); }, []);
  const go = async () => {
    setBusy(true);
    const target = p.id ? encodeURIComponent(p.id) : 'path';
    const extra = p.id ? {} : { path: p.path };
    const r = await act(() => api<{ remote: { label: string }; log: string[] }>(`/api/projects/${target}/remote`, 'POST', mode === 'url' ? { mode, url: url.trim(), push, ...extra } : { mode, account: account || undefined, owner: owner.trim() || undefined, name: name.trim(), visibility: vis, ...extra }));
    setBusy(false);
    if (r) { toast(`${t('연결했습니다')} · ${r.remote.label}${r.log.some((l) => l.includes('실패') || l.includes('Push failed')) ? ` (${t('올리기는 실패 — 대화창 기록 참고')})` : ''}`, 'good'); onDone(); await refreshState(); }
  };
  return (
    <div className="sub-panel rl">
      <div className="set-tabs rl-tabs"><a href="#" className={mode === 'github' ? 'on' : ''} onClick={(e) => { e.preventDefault(); setMode('github'); }}>{t('GitHub 에 새로 만들기')}</a><a href="#" className={mode === 'url' ? 'on' : ''} onClick={(e) => { e.preventDefault(); setMode('url'); }}>{t('이미 있는 주소 연결')}</a></div>
      {mode === 'github' ? (
        accounts === undefined ? <p className="muted small">{t('GitHub 계정 확인 중…')}</p>
          : !accounts?.length ? <p className="muted small">{tn('GitHub CLI(gh)에 로그인된 계정이 없습니다. 맥 터미널에서 {cmd} 후 다시 여세요. 또는 「이미 있는 주소 연결」을 쓰세요.', { cmd: <code className="mono">gh auth login</code> })}</p>
          : (
            <div className="form-grid">
              <label>{t('계정')} <small className="muted">{t('이 계정 권한으로 만듭니다(gh 활성 계정은 바꾸지 않음)')}</small>
                <select value={account} onChange={(e) => { setAccount(e.target.value); setOwner(e.target.value); }}>{accounts.map((a) => <option key={a.login} value={a.login}>{a.login}{a.active ? ` (${t('gh 활성')})` : ''}</option>)}</select>
              </label>
              <label>{t('소유자')} <small className="muted">{t('계정 이름 그대로 또는 조직 이름')}</small><input className="txt mono" value={owner} onChange={(e) => setOwner(e.target.value)} /></label>
              <label>{t('저장소 이름')}<input className="txt mono" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label>{t('공개 여부')}
                <select value={vis} onChange={(e) => setVis(e.target.value as 'private' | 'public')}><option value="private">{t('비공개 (권장)')}</option><option value="public">{t('공개 — 누구나 볼 수 있음')}</option></select>
              </label>
              <div className="wide muted small">{t('github.com/{owner}/{name} 을 만들고 origin 으로 연결한 뒤 지금 브랜치의 커밋을 올립니다. .gitignore 에 든 파일(.env·node_modules 등)은 올라가지 않습니다.', { owner: owner || '…', name: name || '…' })}</div>
              <div className="row wide"><button className="btn primary" type="button" disabled={busy || !name.trim()} onClick={() => void go()}>{busy ? t('만드는 중…') : t('만들고 올리기')}</button></div>
            </div>
          )
      ) : (
        <div className="form-grid">
          <label className="wide">{t('원격 저장소 주소')} <small className="muted">{t('GitHub·GitLab 등에서 「Clone」 주소 (https://… 또는 git@…) · 빈 저장소여야 합니다')}</small><input className="txt mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/me/my-app.git" /></label>
          <label className="chk"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> {t('연결하고 지금 브랜치를 바로 올리기')}</label>
          <div className="row wide"><button className="btn primary" type="button" disabled={busy || url.trim().length < 5} onClick={() => void go()}>{busy ? t('연결 중…') : t('연결')}</button></div>
        </div>
      )}
    </div>
  );
}

function ProjectItem({ p, snap, ro }: { p: Project; snap: StateSnapshot; ro: boolean }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState(false);
  const repo = snap.repos.find((r) => r.project_id === p.id);
  const [d, setD] = useState({ name: p.name, base_ref: p.base_ref, deps_strategy: p.deps_strategy, heavy: p.heavy_patterns.join('\n'), blocked: p.blocked_patterns.join('\n'), memory: p.memory_paths.join('\n'), tpl: p.default_template_id ?? '', git: p.git_mode, prot: p.protected_branches.join(', ') });
  const save = async () => {
    const r = await act(() => api(`/api/projects/${encodeURIComponent(p.id)}`, 'PATCH', {
      name: d.name.trim(), base_ref: d.base_ref.trim(), deps_strategy: d.deps_strategy, heavy_patterns: lines(d.heavy), blocked_patterns: lines(d.blocked), memory_paths: lines(d.memory), default_template_id: d.tpl || null,
      git_mode: d.git, protected_branches: d.prot.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
    }), t('프로젝트를 저장했습니다'));
    if (r !== undefined) { await refreshState(); setOpen(false); }
  };
  const del = async () => { const r = await act(() => api(`/api/projects/${encodeURIComponent(p.id)}`, 'DELETE'), t('프로젝트를 지웠습니다')); if (r !== undefined) await refreshState(); };
  return (
    <div className="item">
      <div className="item-h">
        <div style={{ minWidth: 0 }}><b>{p.name}</b> <span className="muted small mono">{p.base_ref}</span> <span className={`chip${p.git_mode === 'push' ? ' git-on' : ''}`}>{p.git_mode === 'push' ? t('git 커밋·푸시 허용') : t('git 막음')}</span><div className="muted small mono ellipsis">{p.path}</div><div className="ellipsis"><RemoteLine remote={repo?.remote} /></div></div>
        <div className="row">
          {!ro && repo && !repo.remote && <button className="btn" type="button" onClick={() => setLink(!link)}>{link ? t('연결 닫기') : t('원격 연결')}</button>}
          <button className="btn" type="button" onClick={() => setOpen(!open)}>{open ? t('닫기') : ro ? t('보기') : t('수정')}</button>
          {!ro && <ConfirmButton label={t('삭제')} confirmLabel={t('등록을 지울까요? (저장소는 그대로)')} onConfirm={() => void del()} />}
        </div>
      </div>
      {link && !ro && <RemoteLink p={p} onDone={() => setLink(false)} />}
      {open && (
        <fieldset className="form-grid" disabled={ro}>
          <label>{t('이름')}<input className="txt" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={60} /></label>
          <label>{t('기준 브랜치')} <small className="muted">{HELP.base}</small><input className="txt mono" value={d.base_ref} onChange={(e) => setD({ ...d, base_ref: e.target.value })} /></label>
          <label>{t('팀 작업 폴더의 패키지')} <small className="muted">{HELP.deps}</small>
            <select value={d.deps_strategy} onChange={(e) => setD({ ...d, deps_strategy: e.target.value as Project['deps_strategy'] })}>
              {DEPS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <small className="dep-x">{DEPS_EXPLAIN[d.deps_strategy]}</small>
          </label>
          <label>{t('기본 팀 구성')} <small className="muted">{HELP.tpl}</small>
            <select value={d.tpl} onChange={(e) => setD({ ...d, tpl: e.target.value })}><option value="">{t('(없음)')}</option>{snap.templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}</select>
          </label>
          <label>{t('git 권한')} <small className="muted">{t('팀이 직접 커밋·푸시·PR 을 만들 수 있는지')}</small>
            <select value={d.git} onChange={(e) => setD({ ...d, git: e.target.value as Project['git_mode'] })}>
              <option value="none">{t('막음 (커밋·푸시는 사람이)')}</option><option value="push">{t('커밋·푸시·PR 만들기 허용')}</option>
            </select>
          </label>
          <label>{t('보호 브랜치')} <small className="muted">{t('팀이 직접 푸시 못 함 · PR 만 · 쉼표로')}</small><input className="txt mono" value={d.prot} disabled={d.git !== 'push'} onChange={(e) => setD({ ...d, prot: e.target.value })} /></label>
          <label className="wide">{t('무거운 명령')} <small className="muted">{t('테스트·빌드처럼 맥을 많이 쓰는 명령 · 여러 팀이 동시에 돌리지 않게 줄을 세움 · 한 줄에 하나(정규식)')}</small><textarea className="txt area mono" rows={4} value={d.heavy} onChange={(e) => setD({ ...d, heavy: e.target.value })} /></label>
          <label className="wide">{t('막을 명령')} <small className="muted">{t('팀이 실행하지 못하게 막는 명령(운영 배포·DB 등) · 한 줄에 하나(정규식)')}</small><textarea className="txt area mono" rows={4} value={d.blocked} onChange={(e) => setD({ ...d, blocked: e.target.value })} /></label>
          <label className="wide">{t('Claude Code 메모리 폴더')} <small className="muted">{HELP.mem} · {t('한 줄에 하나')}</small><textarea className="txt area mono" rows={2} value={d.memory} onChange={(e) => setD({ ...d, memory: e.target.value })} /></label>
          {!ro && <div className="row wide"><button className="btn primary" type="button" onClick={() => void save()}>{t('저장')}</button></div>}
        </fieldset>
      )}
    </div>
  );
}

/* ---------- 직속 팀 ---------- */
interface StandingForm { name: string; project_id: string; template_id: string; brief: string; check_command: string; check_interval_sec: string; readable: string[] }

function StandingFields({ f, set, snap, isNew, selfId }: { f: StandingForm; set: (f: StandingForm) => void; snap: StateSnapshot; isNew: boolean; selfId?: string }) {
  const others = snap.teams.filter((tm) => tm.id !== selfId && tm.state !== 'archived');
  return (
    <>
      <label>{t('이름')}<input className="txt" value={f.name} maxLength={60} onChange={(e) => set({ ...f, name: e.target.value })} /></label>
      <label>{t('프로젝트')}<select value={f.project_id} onChange={(e) => set({ ...f, project_id: e.target.value })}><option value="">{t('(없음)')}</option>{snap.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>{t('템플릿')}<select value={f.template_id} onChange={(e) => set({ ...f, template_id: e.target.value })}>
        {!isNew && !f.template_id && <option value="">{t('(지금 구성 유지)')}</option>}
        {snap.templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
      </select></label>
      <label className="wide">{t('상시 지시서')}<textarea className="txt area" rows={4} maxLength={20000} value={f.brief} placeholder={t('예: 에러율 2% 넘으면 최근 배포 팀 기록부터 확인하고 보고')} onChange={(e) => set({ ...f, brief: e.target.value })} /></label>
      <label className="wide">{t('점검 명령')} <small className="muted">{t('선택 · 종료 코드가 0이 아니면 팀을 깨움')}</small><input className="txt mono" value={f.check_command} maxLength={2000} placeholder={t('예: curl -fsS https://example.com/health')} onChange={(e) => set({ ...f, check_command: e.target.value })} /></label>
      <label>{t('점검 주기(초)')}<input className="num" type="number" min={30} max={86400} value={f.check_interval_sec} onChange={(e) => set({ ...f, check_interval_sec: e.target.value })} /></label>
      <div className="wide">
        <div className="small muted">{t('읽을 수 있는 다른 팀 기록')}{!isNew && ` (${t('저장하면 이 목록으로 바뀜')})`}</div>
        <div className="checks">
          {others.length ? others.map((tm: TeamView) => (
            <label key={tm.id} className="chk"><input type="checkbox" checked={f.readable.includes(tm.id)} onChange={(e) => set({ ...f, readable: e.target.checked ? [...f.readable, tm.id] : f.readable.filter((x) => x !== tm.id) })} />{tm.title || tm.name}</label>
          )) : <span className="muted small">{t('다른 팀이 없습니다')}</span>}
        </div>
      </div>
    </>
  );
}

/** 수정 폼에서 프로젝트·템플릿이 바뀌었는지(바뀐 값만 보낸다) */
function standingMoves(f: StandingForm, t: TeamView | null): { project: boolean; template: boolean } {
  if (!t) return { project: false, template: false };
  return { project: (f.project_id || null) !== t.project_id, template: !!f.template_id && f.template_id !== (t.template_id ?? '') };
}

function standingBody(f: StandingForm, isNew: boolean, readableTouched: boolean, cur: TeamView | null = null): Record<string, unknown> {
  const iv = f.check_interval_sec.trim() === '' ? null : Number(f.check_interval_sec);
  const b: Record<string, unknown> = { name: f.name.trim(), brief: f.brief, check_command: f.check_command.trim() || null, check_interval_sec: f.check_command.trim() ? iv : null };
  if (isNew) { b.project_id = f.project_id || null; b.template_id = f.template_id || null; }
  else {
    const mv = standingMoves(f, cur);
    if (mv.project) b.project_id = f.project_id || null;
    if (mv.template) b.template_id = f.template_id;
  }
  if (isNew || readableTouched) b.readable_team_ids = f.readable;
  return b;
}

function StandingNew({ snap, onDone }: { snap: StateSnapshot; onDone: () => void }) {
  const [f, setF] = useState<StandingForm>({ name: '', project_id: '', template_id: snap.templates.some((tpl) => tpl.id === 'tpl-ops') ? 'tpl-ops' : (snap.templates[0]?.id ?? ''), brief: '', check_command: '', check_interval_sec: '300', readable: [] });
  const create = async () => {
    const r = await act(() => api('/api/standing', 'POST', standingBody(f, true, true)), t('직속 팀을 만들었습니다'));
    if (r !== undefined) { await refreshState(); onDone(); }
  };
  return (
    <div className="sub-panel">
      <h4>{t('새 직속 팀')}</h4>
      <div className="form-grid">
        <StandingFields f={f} set={setF} snap={snap} isNew />
        <div className="row wide"><button className="btn primary" type="button" disabled={!f.name.trim()} onClick={() => void create()}>{t('만들기')}</button><button className="btn" type="button" onClick={onDone}>{t('취소')}</button></div>
      </div>
    </div>
  );
}

function StandingItem({ t: tm, snap, ro }: { t: TeamView; snap: StateSnapshot; ro: boolean }) {
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [f, setF] = useState<StandingForm>({ name: tm.name, project_id: tm.project_id ?? '', template_id: tm.template_id ?? '', brief: tm.standing_brief, check_command: tm.check_command ?? '', check_interval_sec: tm.check_interval_sec ? String(tm.check_interval_sec) : '300', readable: tm.readable_team_ids });
  const save = async () => {
    const r = await act(() => api(`/api/standing/${encodeURIComponent(tm.id)}`, 'PATCH', standingBody(f, false, touched, tm)), t('직속 팀을 저장했습니다'));
    if (r !== undefined) { await refreshState(); setOpen(false); }
  };
  const archive = async () => { const r = await act(() => api(`/api/teams/${encodeURIComponent(tm.id)}/cancel`, 'POST', {}), t('직속 팀을 종료했습니다')); if (r !== undefined) await refreshState(); };
  return (
    <div className="item">
      <div className="item-h">
        <div style={{ minWidth: 0 }}><a className="link" href={`#team-${tm.id}`}><b>{tm.name}</b></a> <span className="muted small">{tm.project_name ?? t('프로젝트 없음')} · {tm.check_command ? t('{n}초마다 점검', { n: tm.check_interval_sec ?? '?' }) : t('점검 없음')}</span></div>
        {!ro && <div className="row"><button className="btn" type="button" onClick={() => setOpen(!open)}>{open ? t('닫기') : t('수정')}</button><ConfirmButton label={t('종료')} confirmLabel={t('이 직속 팀을 종료할까요?')} onConfirm={() => void archive()} /></div>}
      </div>
      {open && (
        <div className="form-grid">
          <StandingFields f={f} set={(n) => { if (n.readable !== f.readable) setTouched(true); setF(n); }} snap={snap} isNew={false} selfId={tm.id} />
          {(() => { const mv = standingMoves(f, tm); return (mv.project || mv.template) && <div className="wide small muted">{t('저장하면 팀원 대화가 새로 시작되고, 이전 작업 폴더의 변경은 패치로 보관됩니다')}{tm.state === 'running' ? ` · ${t('지금 일하는 중이라 멈추거나 끝난 뒤에 바꿀 수 있습니다')}` : ''}</div>; })()}
          <div className="row wide"><button className="btn primary" type="button" disabled={!f.name.trim()} onClick={() => void save()}>{t('저장')}</button></div>
        </div>
      )}
    </div>
  );
}

/* ---------- 알림 ---------- */
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function enablePush(vapid: string | null, fresh = false): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error(t('이 브라우저는 웹 푸시를 지원하지 않습니다(아이폰은 홈 화면에 추가한 뒤 열어야 합니다)'));
  if (!vapid) throw new Error(t('서버에 VAPID 키가 없습니다'));
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(t('알림 권한이 거부되었습니다'));
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (fresh) await (await reg.pushManager.getSubscription())?.unsubscribe();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapid) }));
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) throw new Error(t('구독 정보를 만들지 못했습니다'));
  const ua = navigator.userAgent;
  const os = ['iPhone', 'iPad', 'Android', 'Macintosh', 'Windows', 'Linux'].find((k) => ua.includes(k)) ?? 'browser';
  const br = ['SamsungBrowser', 'Edg', 'Firefox', 'Chrome', 'Safari'].find((k) => ua.includes(k)) ?? '';
  const device = `${os} · ${br === 'SamsungBrowser' ? t('삼성 인터넷') : br}`;
  await api('/api/push/subscribe', 'POST', { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, device: device.slice(0, 100) });
}

type Step = { name: string; ok: boolean | null; note: string };

/** 이 기기 알림 점검: 어느 단계에서 끊기는지 보여 준다. */
function PushDoctor({ vapid }: { vapid: string | null }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    const out: Step[] = [];
    const push = (s: Step) => { out.push(s); setSteps([...out]); };
    try {
      const support = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      push({ name: t('브라우저 지원'), ok: support, note: support ? t('지원함') : t('이 브라우저는 웹 푸시를 지원하지 않습니다(아이폰은 홈 화면에 추가한 앱에서 열어야 함)') });
      if (!support) return;
      const perm = Notification.permission;
      push({ name: t('알림 권한'), ok: perm === 'granted', note: perm === 'granted' ? t('허용됨') : perm === 'denied' ? t('차단됨 → 주소창 자물쇠(또는 앱 정보) › 알림 허용') : t('아직 안 물어봄 → 위 「알림 켜기」') });
      if (perm !== 'granted') return;
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      try { await reg?.update(); } catch { /* 새 버전 없음 */ }
      push({ name: t('서비스 워커'), ok: !!reg?.active, note: reg?.active ? t('작동 중') : t('없음 → 「다시 구독」') });
      if (!reg?.active) return;
      const sub = await reg.pushManager.getSubscription();
      const known = sub ? (await api<{ known: boolean }>('/api/push/check', 'POST', { endpoint: sub.endpoint })).known : false;
      push({ name: t('구독'), ok: !!sub && known, note: !sub ? t('이 기기에 구독 없음 → 「다시 구독」') : known ? t('서버와 일치') : t('서버에 없는 구독 → 「다시 구독」') });
      if (!sub || !known) return;
      // 기기 자체 표시: 서버를 거치지 않고 이 기기에서 바로 띄운다
      await reg.showNotification(t('Hivelane · 기기 표시 시험'), { body: t('이게 보이면 이 기기는 알림을 띄울 수 있습니다.'), tag: 'local-check', icon: '/icon-512.png' });
      push({ name: t('기기 표시'), ok: null, note: t('방금 「기기 표시 시험」 알림을 띄웠습니다. 안 보이면 휴대폰(또는 맥) 설정에서 이 앱/Chrome 알림이 꺼져 있습니다.') });
      // 서버 → 푸시 서비스 → 이 기기 도착
      let shownHow = '';
      const arrived = new Promise<boolean>((res) => {
        const h = (e: MessageEvent) => { const m = e.data as { type?: string; shown?: string }; if (m?.type === 'hl-push') { navigator.serviceWorker.removeEventListener('message', h); shownHow = m.shown ?? t('알 수 없음(옛 서비스 워커)'); res(true); } };
        navigator.serviceWorker.addEventListener('message', h);
        setTimeout(() => { navigator.serviceWorker.removeEventListener('message', h); res(false); }, 20_000);
      });
      const r = await api<{ ok: boolean; status?: number; error?: string }>('/api/push/test', 'POST', { endpoint: sub.endpoint });
      push({ name: t('서버 발송'), ok: r.ok, note: r.ok ? t('푸시 서비스가 받음({status})', { status: r.status ?? '' }) : `${t('실패:')} ${r.status ?? ''} ${r.error ?? ''}` });
      if (!r.ok) return;
      push({ name: t('이 기기 도착'), ok: null, note: t('기다리는 중(최대 20초)…') });
      const ok = await arrived;
      out.pop();
      push({ name: t('이 기기 도착'), ok, note: ok ? t('도착함(표시: {how}) · 「기기 점검」 알림이 떠야 합니다', { how: shownHow }) : t('20초 안에 안 옴 → 배터리 절전 제한(설정 › 앱 › Chrome › 배터리 › 제한 없음) 확인 후 「다시 구독」') });
    } catch (e) {
      push({ name: t('오류'), ok: false, note: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
      // 결과를 서버 기록에 남긴다(원격 기기 문제를 맥에서 확인하려고)
      void api('/api/push/report', 'POST', { ua: navigator.userAgent.slice(0, 200), steps: out.map((s) => `${s.ok === true ? 'OK' : s.ok === false ? 'FAIL' : '?'} ${s.name}: ${s.note}`) }).catch(() => {});
    }
  };
  return (
    <div className="set-col">
      <div className="row">
        <button className="btn" type="button" disabled={running} onClick={() => void run()}>{running ? t('점검 중…') : t('이 기기 알림 점검')}</button>
        <button className="btn" type="button" onClick={() => void act(() => enablePush(vapid, true), t('새로 구독했습니다'))}>{t('다시 구독(새로 만들기)')}</button>
      </div>
      {steps && (
        <ol className="push-doc">
          {steps.map((s, i) => <li key={i} className={s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'wait'}><b>{s.ok === true ? '✓' : s.ok === false ? '✕' : '…'} {s.name}</b> <span>{s.note}</span></li>)}
        </ol>
      )}
    </div>
  );
}

function TextSetting({ label, sub, value, placeholder, disabled, onSave, mono }: { label: string; sub?: string; value: string; placeholder?: string; disabled: boolean; mono?: boolean; onSave: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="set-col">
      <label>{label}{sub && <small>{sub}</small>}</label>
      <div className="composer">
        <input className={mono ? 'mono' : ''} value={v} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} />
        <button className="btn" type="button" disabled={disabled || v === value} onClick={() => void onSave(v)}>{t('저장')}</button>
      </div>
    </div>
  );
}

interface TsState { installed: boolean; backend: string | null; host: string | null; serving: boolean; url: string | null; otherTargets: string[]; funnel: boolean; error: string | null }
interface RemoteInfo { ownerLogin: string | null; lastRemote: { login: string; at: string } | null; remotePort?: number; tailscale?: TsState | null }

/** 원격 접속 안내: Tailscale·serve·주인 계정 상태에 따라 지금 할 일 하나만 */
function RemoteGuide({ info, owner, onRefresh, busy }: { info: RemoteInfo | null; owner: string | null; onRefresh: () => void; busy: boolean }) {
  const ts = info?.tailscale;
  const port = info?.remotePort ?? 4312;
  const cmd = `tailscale serve --bg ${port}`;
  const copy = (txt: string) => { void navigator.clipboard?.writeText(txt).then(() => toast(t('복사했습니다'), 'good')).catch(() => {}); };
  const again = <button className="link-btn" type="button" disabled={busy} onClick={onRefresh}>{busy ? t('확인 중…') : t('다시 확인')}</button>;
  let tone = 'warn'; let body: ReactNode;
  if (!info) body = <>{t('상태 확인 중…')}</>;
  else if (!ts) body = <>{tn('Tailscale 상태를 읽지 못했습니다. 맥 터미널에서 {cmd} 를 한 번 실행하면 같은 tailnet 기기에서 열 수 있습니다.', { cmd: <code className="mono">{cmd}</code> })}</>;
  else if (!ts.installed) body = <><b>{t('1단계 · Tailscale 설치')}</b><br />{tn('맥과 휴대폰에 {a} 을 깔고 같은 계정으로 로그인하세요. 관리 콘솔 › DNS 에서 HTTPS Certificates 도 켭니다. 그다음 다시 확인을 누르세요.', { a: <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> })}</>;
  else if (!ts.backend && ts.error) body = <><b>{t('Tailscale 상태를 읽지 못했습니다')}</b><br /><span className="mono">{ts.error}</span><br />{tn('맥 터미널에서 {cmd} 로 직접 켤 수 있습니다.', { cmd: <code className="mono">{cmd}</code> })}</>;
  else if (ts.backend !== 'Running') body = <><b>{t('2단계 · Tailscale 연결')}</b><br />{ts.backend === 'NeedsLogin' ? t('Tailscale 이 로그인을 기다립니다.') : t('Tailscale 이 꺼져 있습니다({state}).', { state: ts.backend ?? t('알 수 없음') })} {t('맥 메뉴 막대의 Tailscale 에서 로그인·연결하세요.')}</>;
  else if (ts.funnel) { tone = 'crit'; body = <><b>{t('funnel 이 켜져 있습니다 — 인터넷 누구나 접속을 시도할 수 있습니다.')}</b><br />{tn('터미널에서 {reset} 후 {cmd} 로 tailnet 안에서만 여세요.', { reset: <code className="mono">tailscale funnel reset</code>, cmd: <code className="mono">{cmd}</code> })}</>; }
  else if (!ts.serving) body = <><b>{t('3단계 · 원격 연결 켜기')}</b><br />{t('맥 터미널에서 한 번 실행하세요(맥을 다시 켜도 유지):')} <code className="mono">{cmd}</code> <button className="link-btn" type="button" onClick={() => copy(cmd)}>{t('복사')}</button>{ts.otherTargets.length > 0 && <><br /><span className="muted">{t('지금 serve 는 다른 곳({list})으로 연결돼 있습니다. 위 명령이 Hivelane 으로 바꿉니다.', { list: ts.otherTargets.join(', ') })}</span></>}</>;
  else if (!owner) body = <><b>{t('4단계 · 주인 계정 등록')}</b><br />{t('원격 연결은 켜져 있습니다')} · <a href={ts.url ?? '#'} target="_blank" rel="noreferrer" className="mono">{ts.url}</a> <button className="link-btn" type="button" onClick={() => copy(ts.url ?? '')}>{t('복사')}</button><br />{t('휴대폰에서 이 주소를 한 번 열면 아래 「마지막 원격 접속 시도」에 계정이 뜹니다 → 「이 계정을 주인으로」.')}</>;
  else { tone = 'good'; body = <><b>{t('✓ 휴대폰에서 쓸 수 있습니다')}</b> · <a href={ts.url ?? '#'} target="_blank" rel="noreferrer" className="mono">{ts.url}</a> <button className="link-btn" type="button" onClick={() => copy(ts.url ?? '')}>{t('복사')}</button><br /><span className="muted">{t('휴대폰 브라우저에서 「홈 화면에 추가」하면 앱처럼 쓰고 웹 푸시도 받습니다. funnel 은 쓰지 마세요.')}</span></>; }
  return <div className={`rg ${tone}`}><div className="small">{body}</div><div className="rg-a">{again}</div></div>;
}

const BREW_CMD = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** Ollama 준비 상태: Homebrew → 설치 → 켜기 → 모델 받기 → 준비됨 */
function OllamaPanel({ ro, model }: { ro: boolean; model: string }) {
  const [v, setV] = useState<OllamaView | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<OllamaView>('/api/ollama').then(setV).catch(() => {});
  useEffect(() => { void load(); }, [model]);
  const working = !!v?.job && !v.job.done;
  useEffect(() => { if (!working) return; const iv = setInterval(() => void load(), 1000); return () => clearInterval(iv); }, [working]);
  const call = async (path: string, body: unknown = {}, ok?: string) => { setBusy(true); const r = await act(() => api<OllamaView>(`/api/ollama/${path}`, 'POST', body), ok); if (r) setV(r); setBusy(false); };
  const copy = (txt: string) => { void navigator.clipboard?.writeText(txt).then(() => toast(t('복사했습니다'), 'good')).catch(() => {}); };
  if (!v) return <div className="rg info small">{t('Ollama 상태 확인 중…')}</div>;
  const job = v.job;
  const jobLine = job && (!job.done || job.error) ? (
    <div className="ol-job">
      <span>{job.kind === 'install' ? t('Ollama 설치') : `${t('모델 받기')} ${job.model ?? ''}`}{job.done ? '' : ` ${t('중…')}`}</span>
      {job.pct != null && !job.done && <span className="ol-bar"><i style={{ width: `${job.pct}%` }} /></span>}
      {job.pct != null && !job.done && <span className="mono">{job.pct}%</span>}
      <span className={`muted small mono ${job.error ? 'crit-t' : ''}`}>{job.error ?? job.line}</span>
    </div>
  ) : null;
  let tone = 'warn'; let body: ReactNode;
  if (!v.local) body = <>{t('주소가 이 맥이 아니라 Hivelane 이 관리하지 않습니다')} · {v.running ? t('연결됨({version})', { version: String(v.version) }) : t('연결 안 됨 — 그 서버를 직접 켜세요')}</>;
  else if (!v.installed && !v.brew) body = <><b>{t('1단계 · Homebrew 설치')}</b><br />{t('Ollama 는 Homebrew 로 설치합니다. Homebrew 설치는 맥 관리자 비밀번호가 필요해 터미널에서 직접 한 번 실행하세요:')} <code className="mono">{BREW_CMD}</code> <button className="link-btn" type="button" onClick={() => copy(BREW_CMD)}>{t('복사')}</button><br /><span className="muted">{t('끝나면 「다시 확인」. (또는 ollama.com 에서 Ollama 앱을 받아도 됩니다)')}</span></>;
  else if (!v.installed) body = <><b>{t('2단계 · Ollama 설치')}</b><br />{tn('{cmd} 를 Hivelane 이 실행합니다(몇 분).', { cmd: <code className="mono">brew install ollama</code> })}{!ro && <> <button className="btn primary" type="button" disabled={busy || working} onClick={() => void call('install', {}, t('설치를 시작했습니다'))}>{t('설치')}</button></>}</>;
  else if (!v.running) body = <><b>{t('3단계 · Ollama 켜기')}</b><br />{t('설치돼 있지만 꺼져 있습니다. 켜면 Hivelane 이 함께 관리합니다(Hivelane 이 꺼지면 같이 꺼짐).')}{!ro && <> <button className="btn primary" type="button" disabled={busy} onClick={() => void call('start', {}, t('Ollama 를 켰습니다'))}>{busy ? t('켜는 중…') : t('켜기@Ollama')}</button></>}</>;
  else if (!v.hasModel) body = <><b>{t('4단계 · 모델 받기')}</b><br />{tn('{model} 이 아직 없습니다{size}.', { model: <span className="mono">{v.model}</span>, size: v.model === 'bge-m3' ? t('(약 1.2GB)') : '' })}{!ro && <> <button className="btn primary" type="button" disabled={busy || working} onClick={() => void call('pull', { model: v.model }, t('모델 받기를 시작했습니다'))}>{t('받기@모델')}</button></>}{v.models.length > 0 && <><br /><span className="muted">{t('있는 모델:')} {v.models.join(', ')}</span></>}</>;
  else { tone = 'good'; body = <><b>{t('✓ 준비됨')}</b> · Ollama {v.version} · {t('모델')} <span className="mono">{v.model}</span> · {v.managed ? t('Hivelane 이 켜고 끔') : t('다른 곳(앱·brew services)에서 실행 중')}<br /><span className="muted">{t('처음 켰거나 모델을 바꿨다면 「다시 색인」을 누르세요.')}</span>{v.managed && !ro && <> <button className="link-btn" type="button" onClick={() => void call('stop', {}, t('Ollama 를 껐습니다'))}>{t('끄기@Ollama')}</button></>}</>; }
  return (
    <div className={`rg ${tone}`}>
      <div className="small">{body}{jobLine}</div>
      <div className="rg-a"><button className="link-btn" type="button" onClick={() => void load()}>{t('다시 확인')}</button></div>
    </div>
  );
}

/** 테마 카드 미리보기 */
function ThemePreview({ t }: { t: Theme }) {
  const v = t.vars;
  const st = (k: string) => (t.id === 'default' ? undefined : { background: v[k] });
  return (
    <span className="th-prev" aria-hidden="true" style={st('--bg')}>
      <span className="th-side" style={st('--sb-bg')}><i style={st('--sb-amber')} /><i style={st('--sb-dim')} /><i style={st('--sb-dim')} /></span>
      <span className="th-body">
        <span className="th-card-in" style={t.id === 'default' ? undefined : { background: v['--surface'], borderColor: v['--line'] }}><i style={st('--fg')} /><i className="s" style={st('--muted')} /></span>
        <span className="th-btn" style={st('--accent')} />
      </span>
    </span>
  );
}

/** 나만의 테마 편집기: 바꾸는 즉시 화면에 미리 입힌다(저장 전까지는 임시) */
function ThemeEditor({ prefs, init, onClose }: { prefs: UiPrefs; init: Theme; onClose: (saved: UiPrefs | null) => void }) {
  const [name, setName] = useState(init.name);
  const [scheme, setScheme] = useState<'light' | 'dark'>(init.scheme === 'dark' ? 'dark' : 'light');
  const [font, setFont] = useState(init.font ?? '');
  const [tok, setTok] = useState<Record<string, string>>(() => Object.fromEntries(TOKENS.map((tk) => [tk.v, init.vars[tk.v] ?? '#888888'])));
  const [scale, setScale] = useState<Partial<Record<AreaKey, number>>>(init.scale ?? prefs.scale);
  const draft = (): Theme => ({ id: init.id, name: name.trim() || t('나만의 테마'), desc: `${t('나만의 테마')} · ${scheme === 'dark' ? t('어두움') : t('밝음')}`, scheme, vars: varsFromTokens(scheme, tok), font, scale, custom: true });
  const preview = (): UiPrefs => ({ ...prefs, theme: init.id, scale, custom: [...(prefs.custom ?? []).filter((c) => c.id !== init.id), draft()] });
  useEffect(() => { applyPrefs(preview()); }, [name, scheme, font, tok, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  // 저장하지 않고 다른 화면으로 가면 미리보기를 되돌린다
  useEffect(() => () => { applyPrefs(loadPrefs()); }, []);
  const set = (k: string, v: string) => setTok((prev) => ({ ...prev, [k]: v.toUpperCase() }));
  const save = () => { const n = preview(); savePrefs(n); toast(t('「{name}」를 저장하고 입혔습니다', { name: name.trim() || t('나만의 테마') }), 'good'); onClose(n); };
  const cancel = () => { applyPrefs(prefs); onClose(null); };
  const copy = () => { void navigator.clipboard?.writeText(JSON.stringify({ hivelaneTheme: 1, ...draft(), id: undefined })).then(() => toast(t('테마 코드를 복사했습니다 · 다른 기기에서 「가져오기」에 붙여 넣으세요'), 'good')).catch(() => {}); };
  const groups = ['본문', '왼쪽 목록', '상태'] as const;
  return (
    <div className="panel th-ed">
      <h3>{(prefs.custom ?? []).some((c) => c.id === init.id) ? t('나만의 테마 고치기') : t('나만의 테마 만들기')} <small className="muted">{t('바꾸는 즉시 화면에 미리 보입니다 · 저장해야 남습니다')}</small></h3>
      <div className="form-grid">
        <label>{t('이름')}<input className="txt" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} /></label>
        <label>{t('밝기')} <small className="muted">{t('어두움이면 일부 색(모델 표시 등)도 어두운 판으로')}</small>
          <select value={scheme} onChange={(e) => setScheme(e.target.value as 'light' | 'dark')}><option value="light">{t('밝음')}</option><option value="dark">{t('어두움')}</option></select>
        </label>
        <label>{t('글꼴')}<select value={font} onChange={(e) => setFont(e.target.value)}>{FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
      </div>
      {groups.map((g) => (
        <div key={g} className="th-ed-g">
          <div className="th-ed-gh">{g === '본문' ? t('본문(가운데 화면)') : g === '왼쪽 목록' ? t('왼쪽 목록(사이드바)') : t('상태 색')}</div>
          <div className="th-colors">
            {TOKENS.filter((tk) => tk.group === g).map((tk) => (
              <label key={tk.v} className="th-color">
                <input type="color" value={tok[tk.v]} onChange={(e) => set(tk.v, e.target.value)} aria-label={`${t(g)} ${tk.label}`} />
                <span className="th-cl">{tk.label}</span>
                <input className="txt mono th-hex" value={tok[tk.v]} maxLength={7} onChange={(e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) set(tk.v, e.target.value); }} />
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="th-ed-g">
        <div className="th-ed-gh">{t('글자 크기')} <small className="muted">{t('이 테마를 고르면 함께 적용')}</small></div>
        {AREAS.map((a) => {
          const cur = scale[a.key] ?? 1;
          return (
            <Row key={a.key} label={a.label} sub={a.desc} htmlFor={`ez-${a.key}`}>
              <div className="z-ctl"><input id={`ez-${a.key}`} type="range" min={0} max={SCALES.length - 1} step={1} value={Math.max(0, SCALES.indexOf(cur))} onChange={(e) => setScale({ ...scale, [a.key]: SCALES[Number(e.target.value)] })} /><span className="mono z-v">{Math.round(cur * 100)}%</span></div>
            </Row>
          );
        })}
      </div>
      <div className="row th-ed-acts"><button className="btn primary" type="button" onClick={save}>{t('저장')}</button><button className="btn" type="button" onClick={cancel}>{t('취소')}</button><button className="btn ghost" type="button" onClick={copy}>{t('테마 코드 복사')}</button></div>
    </div>
  );
}

/** 화면: 테마(프리셋 + 나만의 테마) + 영역별 글자 크기(이 기기에만) */
function DisplayPanel() {
  const [p, setP] = useState<UiPrefs>(() => loadPrefs());
  const [edit, setEdit] = useState<Theme | null>(null);
  const [imp, setImp] = useState<string | null>(null);
  const set = (n: UiPrefs) => { setP(n); savePrefs(n); };
  const pick = (th: Theme) => set({ ...p, theme: th.id, ...(th.scale ? { scale: th.scale } : {}) });
  const startNew = () => {
    const base = allThemes(p).find((x) => x.id === p.theme) ?? THEMES[0]!;
    setEdit({ id: `c-${Date.now().toString(36)}`, name: t('{name} 변형', { name: base.name }), desc: '', scheme: base.scheme === 'dark' || (base.scheme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light', vars: currentTokens(), font: base.font, scale: p.scale, custom: true });
  };
  const del = (th: Theme) => set({ ...p, custom: (p.custom ?? []).filter((c) => c.id !== th.id), theme: p.theme === th.id ? 'default' : p.theme });
  const doImport = () => {
    try {
      const j = JSON.parse(imp ?? '') as Partial<Theme> & { hivelaneTheme?: number };
      if (!j.hivelaneTheme || !j.vars || typeof j.vars !== 'object') throw new Error(t('Hivelane 테마 코드가 아닙니다'));
      const th: Theme = { id: `c-${Date.now().toString(36)}`, name: String(j.name ?? t('가져온 테마')).slice(0, 30), desc: String(j.desc ?? t('나만의 테마')), scheme: j.scheme === 'dark' ? 'dark' : 'light', vars: Object.fromEntries(Object.entries(j.vars).filter(([k, v]) => /^--[\w-]+$/.test(k) && typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s]+\))$/i.test(v))), font: typeof j.font === 'string' ? j.font : '', scale: j.scale, custom: true };
      set({ ...p, custom: [...(p.custom ?? []), th], theme: th.id, ...(th.scale ? { scale: th.scale } : {}) });
      setImp(null); toast(t('「{name}」를 가져와 입혔습니다', { name: th.name }), 'good');
    } catch (e) { toast(e instanceof Error ? e.message : t('가져오지 못했습니다'), 'crit'); }
  };
  if (edit) return <ThemeEditor prefs={p} init={edit} onClose={(n) => { setEdit(null); if (n) setP(n); }} />;
  return (
    <div className="stack-s">
      <div className="panel">
        <h3>{t('언어')} <small className="muted">{t('화면에 보이는 말 · 이 기기에만 저장 · AI 답변·알림 언어는 설정 › 총괄·엔진에서')}</small></h3>
        <div className="bk-seg" role="radiogroup" aria-label="Language">
          {(['ko', 'en'] as const).map((l) => <button key={l} type="button" role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => { if (l !== lang) setLang(l); }}>{l === 'ko' ? '한국어' : 'English'}</button>)}
        </div>
      </div>
      <div className="panel">
        <h3>{t('테마')} <small className="muted">{t('색만 바뀌고 화면 구성은 그대로 · 이 기기에만 저장(맥·휴대폰 따로)')}</small></h3>
        <div className="th-grid">
          {allThemes(p).map((th) => {
            const on = p.theme === th.id;
            return (
              <div key={th.id} className="th-wrap">
                <button type="button" className={`th-card${on ? ' on' : ''}`} aria-pressed={on} onClick={() => pick(th)}>
                  <ThemePreview t={th} />
                  <span className="th-name">{th.name}{th.custom && <span className="chip th-mine">{t('나만의')}</span>}{on && <span className="th-check"> ✓</span>}</span>
                  <span className="th-desc">{th.desc}</span>
                </button>
                {th.custom && <div className="th-acts"><button className="link-btn" type="button" onClick={() => setEdit(th)}>{t('고치기')}</button><button className="link-btn" type="button" onClick={() => { const c = { ...th, id: `c-${Date.now().toString(36)}`, name: t('{name} 사본', { name: th.name }) }; set({ ...p, custom: [...(p.custom ?? []), c] }); }}>{t('복제')}</button><ConfirmButton className="link-btn" label={t('지우기')} confirmLabel={t('지울까요?')} onConfirm={() => del(th)} /></div>}
              </div>
            );
          })}
          <button type="button" className="th-card th-new" onClick={startNew}><span className="th-plus">＋</span><span className="th-name">{t('나만의 테마 만들기')}</span><span className="th-desc">{t('지금 테마에서 시작해 색·글꼴·글자 크기를 바꿔 저장')}</span></button>
        </div>
        <div className="row th-imp">
          {imp === null ? <button className="link-btn" type="button" onClick={() => setImp('')}>{t('테마 코드 가져오기')}</button> : (
            <>
              <textarea className="txt mono" rows={3} value={imp} onChange={(e) => setImp(e.target.value)} placeholder={t('다른 기기에서 「테마 코드 복사」한 내용을 붙여 넣기')} />
              <div className="row"><button className="btn primary" type="button" disabled={!imp.trim()} onClick={doImport}>{t('가져오기')}</button><button className="btn" type="button" onClick={() => setImp(null)}>{t('취소')}</button></div>
            </>
          )}
        </div>
      </div>
      <div className="panel">
        <h3>{t('글자 크기')} <small className="muted">{t('영역마다 따로 · 이 기기에만 저장')}</small></h3>
        {AREAS.map((a) => {
          const cur = p.scale[a.key] ?? 1;
          return (
            <Row key={a.key} label={a.label} sub={a.desc} htmlFor={`z-${a.key}`}>
              <div className="z-ctl">
                <input id={`z-${a.key}`} type="range" min={0} max={SCALES.length - 1} step={1} value={Math.max(0, SCALES.indexOf(cur))} onChange={(e) => set({ ...p, scale: { ...p.scale, [a.key]: SCALES[Number(e.target.value)] } })} />
                <span className="mono z-v">{Math.round(cur * 100)}%</span>
              </div>
            </Row>
          );
        })}
        <div className="z-reset"><button className="btn" type="button" onClick={() => set({ ...p, scale: {} })}>{t('글자 크기 처음대로')}</button><span className="muted small">{t('화면 전체를 키우려면 브라우저 확대(⌘ +)도 됩니다')}</span></div>
      </div>
    </div>
  );
}

const fmtBytes = (b: number | null) => (b == null ? '?' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

/** 저장 공간: DB(무엇이 얼마나)·폴더·Ollama 모델 + DB 압축 */
function StoragePanel({ ro }: { ro: boolean }) {
  const [v, setV] = useState<StorageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const load = (fresh = false) => { setBusy(true); void api<StorageView>(`/api/storage${fresh ? '?fresh=1' : ''}`).then(setV).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'crit')).finally(() => setBusy(false)); };
  useEffect(() => load(), []);
  const compact = async () => { setSure(false); setBusy(true); const r = await act(() => api<{ before: number; after: number }>('/api/storage/compact', 'POST', {})); setBusy(false); if (r) { toast(`${t('DB 압축')} · ${fmtBytes(r.before)} → ${fmtBytes(r.after)}`, 'good'); load(true); } };
  if (!v) return <div className="panel muted">{t('재는 중… (폴더 크기를 세느라 몇 초)')}</div>;
  const dbTotal = v.db.file + v.db.wal + v.db.shm;
  const dirTotal = v.dirs.filter((d) => d.key !== 'ollama').reduce((a, d) => a + (d.bytes ?? 0), 0);
  const maxG = Math.max(1, ...v.groups.map((g) => g.bytes));
  return (
    <div className="stack-s">
      <div className="panel st-sum">
        <div><small>DB</small><b>{fmtBytes(dbTotal)}</b><span className="muted small">{t('본 파일 {file} · 쓰기 대기(WAL) {wal}', { file: fmtBytes(v.db.file), wal: fmtBytes(v.db.wal) })}</span></div>
        <div><small>{t('폴더')}</small><b>{fmtBytes(dirTotal)}</b><span className="muted small">{t('worktree·패치·로그·이미지 등')}</span></div>
        <div><small>{t('Hivelane 합계')}</small><b>{fmtBytes(dbTotal + dirTotal)}</b><span className="muted small mono">{v.home.replace(/^\/Users\/[^/]+/, '~')}</span></div>
      </div>
      <div className="panel">
        <h3>{t('DB 안에서 차지하는 것')} <small className="muted">{t('기록 {docs}건 검색 가능 · 팀 {teams} · 팀 대화 {messages} · 총괄 대화 {chat} · 진행 기록 {events}', { docs: v.counts.docs.toLocaleString(), teams: v.counts.teams, messages: v.counts.messages.toLocaleString(), chat: v.counts.chat.toLocaleString(), events: v.counts.events.toLocaleString() })}</small></h3>
        <div className="st-list">
          {v.groups.map((g) => (
            <div key={g.label} className="st-row">
              <span className="st-l">{g.label}{g.note && <span className="muted small"> · {g.note}</span>}</span>
              <span className="st-bar"><i style={{ width: `${Math.max(1, (g.bytes / maxG) * 100)}%` }} /></span>
              <span className="mono st-n">{fmtBytes(g.bytes)}</span>
            </div>
          ))}
        </div>
        <div className="row st-act">
          <span className="muted small">{t('지운 기록이 남긴 빈 공간 {size}', { size: fmtBytes(v.db.free) })}{v.db.free > 0 ? ` · ${t('압축하면 돌려받습니다')}` : ''}</span>
          {!ro && (!sure
            ? <button className="btn" type="button" disabled={busy} onClick={() => setSure(true)}>{t('DB 압축')}</button>
            : <span className="confirm"><span>{t('몇 초 동안 기록 쓰기가 멈춥니다. 팀이 쉴 때 권장.')}</span><button className="btn danger" type="button" onClick={() => void compact()}>{t('압축')}</button><button className="btn" type="button" onClick={() => setSure(false)}>{t('취소')}</button></span>)}
        </div>
      </div>
      <div className="panel">
        <h3>{t('폴더')}</h3>
        <div className="st-list">
          {v.dirs.map((d) => (
            <div key={d.key} className="st-row">
              <span className="st-l">{d.label}<span className="muted small mono"> · {d.path.replace(/^\/Users\/[^/]+/, '~')}</span>{d.note && <span className="muted small"> · {d.note}</span>}{d.key === 'archive' && v.counts.patches > 0 && <span className="muted small"> · {t('패치 {n}개', { n: v.counts.patches })}</span>}</span>
              <span className="mono st-n">{fmtBytes(d.bytes)}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="muted small">{t('자동 정리: 팀원 진행·명령 실행 기록은 팀이 끝나고 14일 뒤, 리소스 측정은 하루, 끝난 팀 worktree 는 7일(설정 › 총괄·엔진) 뒤. 대화·요약·바뀐 파일·패치는 계속 남습니다.')} · {t('{time} 기준', { time: new Date(v.takenAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })} <button className="link-btn" type="button" disabled={busy} onClick={() => load(true)}>{busy ? t('재는 중…') : t('다시 재기')}</button></p>
    </div>
  );
}

const fmtAt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');

/** 색인 상태: 기록 수·벡터 수·모델·마지막 색인·오류 + 다시 색인(진행률) */
function IndexStatus({ ro, provider, model }: { ro: boolean; provider: string; model: string }) {
  const [v, setV] = useState<SearchStatusView | null>(null);
  const load = () => api<SearchStatusView>('/api/search/status').then(setV).catch(() => {});
  useEffect(() => { void load(); }, [provider, model]);
  const running = !!v?.job?.running;
  useEffect(() => { const iv = setInterval(() => void load(), running ? 1000 : 15000); return () => clearInterval(iv); }, [running]);
  const start = async () => { const r = await act(() => api<SearchStatusView>('/api/search/reindex', 'POST', {}), t('다시 색인을 시작했습니다')); if (r) setV(r); };
  if (!v) return null;
  const pct = v.docs ? Math.round((v.vectors / v.docs) * 100) : 0;
  if (provider === 'off') return <div className="ix small muted">{t('전문 검색 색인 {n}건 · 기록이 생길 때마다 바로 들어갑니다', { n: v.docs.toLocaleString() })}</div>;
  const needFull = v.vectors === 0 || v.modelMismatch;
  const recentErr = v.lastError && (!v.lastAddAt || (v.lastErrorAt ?? '') > v.lastAddAt) && (!v.lastFullAt || (v.lastErrorAt ?? '') > v.lastFullAt);
  return (
    <div className="ix">
      <div className="ix-h"><b>{t('색인 상태')}</b>{needFull ? <span className="chip warn-t">{t('다시 색인 필요')}</span> : pct >= 99 ? <span className="chip st-done">{t('최신')}</span> : <span className="chip">{t('일부')}</span>}</div>
      <div className="ix-row"><span className="ix-k">{t('벡터 색인')}</span><span className="ol-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></span><span className="mono">{t('{done} / {total}건 ({pct}%)', { done: v.vectors.toLocaleString(), total: v.docs.toLocaleString(), pct })}</span></div>
      <div className="ix-row"><span className="ix-k">{t('색인 모델')}</span><span className="mono">{v.indexedWith ? `${v.indexedWith.model}${v.dim ? ` · ${t('{n}차원', { n: v.dim })}` : ''}` : v.vectors ? `${t('기록 없음(이전 판에서 색인)')}${v.dim ? ` · ${t('{n}차원', { n: v.dim })}` : ''}` : '-'}</span>{v.modelMismatch && <span className="warn-t small">{t('지금 모델({model})과 달라 벡터 검색을 쓰지 않습니다 → 다시 색인', { model: v.model })}</span>}</div>
      <div className="ix-row"><span className="ix-k">{t('마지막 전체 색인')}</span><span>{v.lastFullAt ? `${fmtAt(v.lastFullAt)}${v.lastFullCount != null ? ` · ${t('{n}건', { n: v.lastFullCount.toLocaleString() })}` : ''}` : v.vectors ? t('기록 없음(이전 판) · 다시 색인하면 남습니다') : t('아직 없음')}</span></div>
      <div className="ix-row"><span className="ix-k">{t('마지막 추가')}</span><span>{fmtAt(v.lastAddAt)} <span className="muted small">{t('(새 기록은 생길 때 자동으로 들어감)')}</span></span></div>
      {recentErr && <div className="ix-row crit-t small"><span className="ix-k">{t('오류')}</span><span>{fmtAt(v.lastErrorAt)} · {v.lastError}</span></div>}
      {v.job?.running && <div className="ix-row"><span className="ix-k">{t('다시 색인 중')}</span><span className="ol-bar"><i style={{ width: `${v.job.total ? Math.round((v.job.done / v.job.total) * 100) : 0}%` }} /></span><span className="mono">{v.job.done.toLocaleString()} / {v.job.total.toLocaleString()}</span></div>}
      {v.job && !v.job.running && v.job.error && <div className="ix-row crit-t small">{t('다시 색인 실패:')} {v.job.error}</div>}
      {!ro && <div className="row"><button className={`btn${needFull ? ' primary' : ''}`} type="button" disabled={running || !v.enabled} onClick={() => void start()}>{running ? t('색인 중…') : t('다시 색인')}</button>{!v.enabled && <span className="muted small">{v.vecReady ? t('임베딩이 준비되면 누를 수 있습니다') : t('벡터 확장(sqlite-vec)을 불러오지 못했습니다')}</span>}</div>}
    </div>
  );
}

/** 검색 안내: 고른 방식에 따라 */
function SearchGuide({ provider }: { provider: 'off' | 'ollama' | 'voyage' }) {
  return (
    <div className="rg info small">
      <b>{t('무엇에 쓰나')}</b> — {tn('총괄이 지난 기록(팀 대화·보고·요약·배운 것)을 찾을 때 씁니다. 기본 {fts}은 늘 켜져 있고 글자가 겹치는 기록을 찾습니다(한국어 3글자 조각).', { fts: <b>{t('전문 검색')}</b> })} {tn('임베딩({vec})을 켜면 말이 달라도 뜻이 비슷한 기록까지 찾습니다(예: 「결제 오류」로 「PG 승인 실패」 찾기). 기록이 적거나 단어로 충분하면 꺼 둬도 됩니다.', { vec: <b>{t('벡터 검색')}</b> })}
      {provider === 'off' && <><br /><span className="muted">{t('켜려면 Ollama(맥 안에서 무료) 또는 Voyage(클라우드 유료)를 고르세요.')}</span></>}
      {provider === 'ollama' && <><br /><b>Ollama</b> · {t('기록이 맥 밖으로 나가지 않습니다. 아래 준비 상태에서 설치·켜기·모델 받기를 버튼으로 합니다. Hivelane 이 켜질 때 같이 켜지고 꺼질 때 같이 꺼집니다(터미널 필요 없음).')}</>}
      {provider === 'voyage' && <><br /><b>Voyage</b> · {tn('기록 글이 voyageai.com 으로 보내집니다(유료). 서버 환경 변수 {key} 가 있어야 합니다(launchd 서비스면 plist 에 넣고 다시 설치). 모델 예: voyage-3.5. 주소 칸은 쓰지 않습니다. 바꾼 뒤 「다시 색인」.', { key: <code className="mono">VOYAGE_API_KEY</code> })}</>}
      <br /><span className="muted">{t('「다시 색인」은 지금까지의 기록을 처음부터 다시 넣습니다(방식·모델을 바꿨을 때).')}</span>
    </div>
  );
}

export type SettingsTab = 'engine' | 'projects' | 'standing' | 'notify' | 'remote' | 'search' | 'storage' | 'display' | 'accounts' | 'backup';

export function Settings({ snap, tab = 'engine' }: { snap: StateSnapshot; tab?: SettingsTab }) {
  const ro = snap.access === 'remote';
  const s = snap.settings;
  const [newStanding, setNewStanding] = useState(false);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [rBusy, setRBusy] = useState(false);
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off'>('unknown');

  useEffect(() => {
    api<RemoteInfo>('/api/remote').then(setRemote).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'crit'));
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration('/sw.js').then(async (reg) => setPushState(reg && (await reg.pushManager.getSubscription()) ? 'on' : 'off')).catch(() => setPushState('off'));
    } else setPushState('off');
  }, [s.ownerLogin]);

  const eng = (k: keyof EngineSettings) => (v: number) => saveSettings({ engine: { [k]: v } });
  const standing = snap.teams.filter((tm) => tm.lifetime === 'standing' && tm.state !== 'archived');

  return (
    <>
      {ro && <div className="ro-note">{t('원격 접속에서는 보기만 할 수 있습니다. 설정·프로젝트·직속 팀은 맥에서 바꾸세요.')}</div>}
      {tab === 'engine' && <Section title={t('총괄·엔진')} sub={t('바꾸면 사이드바 게이지 기준선과 총괄 엔진 판단에 바로 반영')}>
        <div className="set-grid">
          <div className="panel"><h3>{t('총괄 엔진 · 구간 기준')}</h3>
            {ENGINE_ROWS.map(([k, l, sub, u]) => <Row key={k} label={l} sub={sub} htmlFor={`set-${k}`}><NumField id={`set-${k}`} value={s.engine[k]} unit={u} disabled={ro} onSave={eng(k)} /></Row>)}
          </div>
          <div className="stack">
            <div className="panel"><h3>{t('동시 실행')}</h3>
              {CONC_ROWS.map(([k, l, sub, u]) => <Row key={k} label={l} sub={sub} htmlFor={`set-${k}`}><NumField id={`set-${k}`} value={s.engine[k]} unit={u} disabled={ro} onSave={eng(k)} /></Row>)}
            </div>
            <div className="panel"><h3>{t('총괄 에이전트')}</h3>
              <Row label={t('AI 답변·알림 언어')} sub={t('총괄·팀이 답하는 말과 알림·시스템 메시지의 언어 · 화면 언어는 설정 › 화면에서 기기마다')} htmlFor="set-lang">
                <select id="set-lang" disabled={ro} value={s.lang ?? 'ko'} onChange={(e) => void saveSettings({ lang: e.target.value as 'ko' | 'en' })}>
                  <option value="ko">한국어</option><option value="en">English</option>
                </select>
              </Row>
              <Row label={t('총괄 모델')} htmlFor="set-poModel">
                <select id="set-poModel" disabled={ro} value={s.poModel} onChange={(e) => void saveSettings({ poModel: e.target.value as Model })}>
                  <option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
                </select>
              </Row>
              <Row label={t('팀 구성 자동 승인')} sub={t('켜면 총괄 제안을 확인 없이 바로 시작')} htmlFor="set-auto">
                <input className="switch" type="checkbox" id="set-auto" disabled={ro} checked={s.autoApprove} onChange={(e) => void saveSettings({ autoApprove: e.target.checked }, e.target.checked ? t('자동 승인을 켰습니다') : t('자동 승인을 껐습니다'))} />
              </Row>
              <Row label={t('업무 기본 예산')} sub={t('비우면 무제한 · 팀마다 승인할 때 바꿀 수 있음')} htmlFor="set-budget"><BudgetField id="set-budget" value={s.defaultBudgetUsd} disabled={ro} onSave={(v) => saveSettings({ defaultBudgetUsd: v })} /></Row>
              <Row label={t('맥락 한도')} sub={t('넘으면 새 총괄 세션 + 요약으로 시작')} htmlFor="set-ctx"><NumField id="set-ctx" value={s.contextLimitTokens} unit={t('토큰')} step={1000} disabled={ro} onSave={(v) => saveSettings({ contextLimitTokens: v })} /></Row>
              <Row label={t('끝난 팀 worktree 자동 정리')} sub={t('끝난 지 이 일수가 지나면 변경을 패치로 남기고 worktree 를 지움(브랜치는 남김) · 0이면 끔')} htmlFor="set-autoclean"><NumField id="set-autoclean" value={s.autoCleanDays} unit={t('일')} step={1} disabled={ro} onSave={(v) => saveSettings({ autoCleanDays: Math.max(0, Math.min(365, Math.round(v))) })} /></Row>
            </div>
          </div>
        </div>
      </Section>}

      {tab === 'accounts' && <AccountsSection snap={snap} ro={ro} />}

      {tab === 'backup' && <BackupSection snap={snap} />}

      {tab === 'projects' && <Section title={t('프로젝트@목록')} sub={t('팀이 일할 git 저장소')}>
        <div className="panel stack-s">
          {snap.projects.length ? snap.projects.map((p) => <ProjectItem key={`${p.id}:${JSON.stringify(p)}`} p={p} snap={snap} ro={ro} />) : <div className="muted">{t('등록된 프로젝트가 없습니다.')}</div>}
          {!ro && <ProjectNew snap={snap} />}
        </div>
      </Section>}

      {tab === 'standing' && <Section title={t('직속 팀@목록')} right={!ro && !newStanding ? <button className="back" type="button" onClick={() => setNewStanding(true)}>+ {t('직속 팀 추가')}</button> : <span>{t('총괄을 거치지 않고 바로 지시하는 상시 팀')}</span>}>
        <div className="panel stack-s">
          {standing.length ? standing.map((tm) => <StandingItem key={`${tm.id}:${tm.name}:${tm.standing_brief}:${tm.check_command ?? ''}:${tm.check_interval_sec ?? ''}:${tm.project_id ?? ''}:${tm.template_id ?? ''}`} t={tm} snap={snap} ro={ro} />) : <div className="muted">{t('직속 팀이 없습니다.')}</div>}
          {newStanding && <StandingNew snap={snap} onDone={() => setNewStanding(false)} />}
        </div>
      </Section>}

      <div className="set-one">
        {tab === 'notify' && <Section title={t('알림')} sub={t('사람 확인 필요·완료·실패·장애')}>
          <div className="panel stack-s">
            <Row label={t('읽지 않은 답변 다시 알림')} sub={t('답을 안 읽으면 이 간격(분)마다 다시 알림 · 0이면 끔')} htmlFor="set-remind"><NumField id="set-remind" value={s.remindUnreadMin} unit={t('분')} step={5} disabled={ro} onSave={(v) => saveSettings({ remindUnreadMin: Math.max(0, Math.round(v)) })} /></Row>
            <TextSetting label={t('슬랙 웹훅')} sub={t('비우면 끔')} value={s.slackWebhook ?? ''} placeholder="https://hooks.slack.com/services/…" mono disabled={ro} onSave={(v) => saveSettings({ slackWebhook: v.trim() || null })} />
            {isDesktopApp ? (
              <div className="set-col">
                <label>{t('맥 알림 (이 앱)')}<small>{t('맥 앱에서는 웹 푸시 대신 맥 기본 알림으로 받습니다. 앱이 켜져 있으면(창을 닫아도 메뉴 막대에 있으면) 알림이 옵니다.')}</small></label>
                <div className="row">
                  <button className="btn primary" type="button" onClick={() => void act(async () => { if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission(); await api('/api/push/test', 'POST', {}); }, t('시험 알림을 보냈습니다'))}>{t('시험 알림')}</button>
                </div>
                <div className="small muted">{t('알림이 안 뜨면: 시스템 설정 › 알림 › Hivelane 에서 알림 허용을 켜세요. 휴대폰 알림은 휴대폰 브라우저(홈 화면 앱)에서 「알림 켜기」를 하세요.')}</div>
              </div>
            ) : (
            <div className="set-col">
                <label>{t('웹 푸시 (이 기기)')}<small>{pushState === 'on' ? t('이 기기는 구독 중입니다') : t('이 기기에서 알림을 받으려면 켜세요')}</small></label>
                <div className="row">
                  <button className="btn primary" type="button" onClick={() => void act(async () => { await enablePush(snap.vapidPublicKey); setPushState('on'); }, t('이 기기에서 알림을 받습니다'))}>{pushState === 'on' ? t('다시 구독') : t('알림 켜기')}</button>
                  <button className="btn" type="button" onClick={() => void act(() => api('/api/push/test', 'POST', {}), t('시험 알림을 보냈습니다'))}>{t('시험 알림')}</button>
                </div>
                <PushDoctor vapid={snap.vapidPublicKey} />
              </div>
            )}
          </div>
        </Section>}
        {tab === 'remote' && <Section title={t('원격 접속')} sub={t('Tailscale 로 휴대폰에서 보기')}>
          <div className="panel stack-s">
            <RemoteGuide info={remote} owner={s.ownerLogin} busy={rBusy} onRefresh={() => { setRBusy(true); api<RemoteInfo>('/api/remote?fresh=1').then(setRemote).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'crit')).finally(() => setRBusy(false)); }} />
            <TextSetting label={t('주인 계정')} sub={t('Tailscale 로그인 (예: me@github)')} value={s.ownerLogin ?? ''} mono disabled={ro} onSave={(v) => saveSettings({ ownerLogin: v.trim() || null })} />
            <div className="small muted">
              {t('마지막 원격 접속 시도:')} {remote?.lastRemote ? <><span className="mono">{remote.lastRemote.login}</span> · {hhmm(remote.lastRemote.at)}</> : t('없음')}
              {remote?.lastRemote && remote.lastRemote.login !== s.ownerLogin && !ro && (
                <> <button className="btn" type="button" onClick={() => { const login = remote.lastRemote?.login; if (login) void saveSettings({ ownerLogin: login }, t('{login} 을(를) 주인으로 등록했습니다', { login })); }}>{t('이 계정을 주인으로')}</button></>
              )}
            </div>
          </div>
        </Section>}
        {tab === 'display' && <Section title={t('화면')} sub={t('테마와 글자 크기')}><DisplayPanel /></Section>}
        {tab === 'storage' && <Section title={t('저장 공간')} sub={t('DB·폴더가 디스크를 얼마나 쓰는지')}><StoragePanel ro={ro} /></Section>}
        {tab === 'search' && <Section title={t('검색')} sub={t('벡터 검색(선택)')}>
          <div className="panel stack-s">
            <Row label={t('임베딩')} htmlFor="set-emb">
              <select id="set-emb" disabled={ro} value={s.embedding.provider} onChange={(e) => { const provider = e.target.value as SettingsT['embedding']['provider']; const model = provider === 'voyage' && s.embedding.model === 'bge-m3' ? 'voyage-3.5' : provider === 'ollama' && s.embedding.model.startsWith('voyage') ? 'bge-m3' : s.embedding.model; void saveSettings({ embedding: { provider, model } }); }}>
                <option value="off">{t('끔 (전문 검색만)')}</option><option value="ollama">Ollama</option><option value="voyage">Voyage</option>
              </select>
            </Row>
            <SearchGuide provider={s.embedding.provider} />
            {s.embedding.provider === 'ollama' && <OllamaPanel ro={ro} model={s.embedding.model} />}
            {s.embedding.provider !== 'off' && <TextSetting label={t('모델')} sub={s.embedding.provider === 'ollama' ? t('ollama pull 로 받은 이름') : t('Voyage 모델 이름')} value={s.embedding.model} mono disabled={ro} onSave={(v) => saveSettings({ embedding: { model: v.trim() } })} />}
            {s.embedding.provider === 'ollama' && <TextSetting label={t('주소')} sub={t('Ollama 서버')} value={s.embedding.url} mono disabled={ro} onSave={(v) => saveSettings({ embedding: { url: v.trim() } })} />}
            <IndexStatus ro={ro} provider={s.embedding.provider} model={s.embedding.model} />
          </div>
        </Section>}
      </div>
      <p className="note-sample">Hivelane {snap.version} · {ro ? t('원격 접속') : t('로컬 접속')}</p>
    </>
  );
}
