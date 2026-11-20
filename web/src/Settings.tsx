import { useEffect, useState, type ReactNode } from 'react';
import type { EngineSettings, Model, Project, Settings as SettingsT, StateSnapshot, TeamView } from '../../shared/types.ts';
import { act, api, refreshState, toast } from './store.ts';
import { ConfirmButton, Section, hhmm } from './ui.tsx';

type SettingsPatch = Partial<Omit<SettingsT, 'engine' | 'embedding'>> & { engine?: Partial<EngineSettings>; embedding?: Partial<SettingsT['embedding']> };
const saveSettings = (patch: SettingsPatch, ok = '저장했습니다') => act(async () => { await api('/api/settings', 'PUT', patch); await refreshState(); return true; }, ok);

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

const ENGINE_ROWS: [keyof EngineSettings, string, string, string][] = [
  ['cpuY', 'CPU 노랑', '이 이상 지속되면 새 팀 시작 안 함', '%'],
  ['cpuR', 'CPU 빨강', '넘으면 낮은 우선순위 팀부터 멈춤', '%'],
  ['memY', '메모리 노랑', '', '%'],
  ['memR', '메모리 빨강', '', '%'],
  ['memHard', '메모리 한계', '「멈추지 않음」 팀도 멈춤', '%'],
  ['sustainSec', '구간 판정 지속', '이 시간 동안 이어져야 구간을 바꿈', '초'],
  ['resumeSec', '재개 대기', '초록이 이만큼 유지되면 하나씩 재개', '초'],
  ['hardPauseSec', '강한 멈춤까지', '빨강이 이만큼 이어지면 프로세스 정지', '초'],
  ['pauseEverySec', '멈춤 간격', '빨강에서 팀을 하나씩 멈추는 간격', '초'],
  ['stallMin', '정체 판단', '활동이 없으면 PO를 깨움', '분'],
  ['beatSec', '직속 팀 생존 확인 간격', '무응답이면 되살리기 시작', '초'],
];
const CONC_ROWS: [keyof EngineSettings, string, string, string][] = [
  ['cap', '동시 PO 팀 상한', '직속 팀은 세지 않음', '개'],
  ['slotsGreen', '무거운 명령 자리 (초록)', 'jest·vitest·tsc·build', '개'],
  ['slotsYellow', '무거운 명령 자리 (노랑)', '', '개'],
];

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/* ---------- 프로젝트 ---------- */
interface RepoInfo { root: string; name: string; baseRef: string; memoryPaths: string[] }

function ProjectNew({ snap }: { snap: StateSnapshot }) {
  const [path, setPath] = useState('');
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [name, setName] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [deps, setDeps] = useState<Project['deps_strategy']>('symlink');
  const [tpl, setTpl] = useState('tpl-dev');
  const [busy, setBusy] = useState(false);
  const inspect = async () => {
    setBusy(true);
    const r = await act(() => api<RepoInfo>('/api/projects/inspect', 'POST', { path: path.trim() }));
    setBusy(false);
    if (r) { setInfo(r); setName(r.name); setBaseRef(r.baseRef); }
  };
  const add = async () => {
    if (!info) return;
    setBusy(true);
    const r = await act(() => api<Project>('/api/projects', 'POST', { path: info.root, name: name.trim() || undefined, base_ref: baseRef.trim() || undefined, deps_strategy: deps, default_template_id: tpl || null }), '프로젝트를 등록했습니다');
    setBusy(false);
    if (r) { setInfo(null); setPath(''); await refreshState(); }
  };
  return (
    <div className="sub-panel">
      <h4>새 프로젝트 등록</h4>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void inspect(); }}>
        <input value={path} onChange={(e) => { setPath(e.target.value); setInfo(null); }} placeholder="저장소 경로 (예: ~/code/my-app)" aria-label="저장소 경로" />
        <button className="btn" type="submit" disabled={!path.trim() || busy}>확인</button>
      </form>
      {info && (
        <div className="form-grid">
          <div className="muted small">경로: <span className="mono">{info.root}</span></div>
          <div className="muted small">참조 메모리: {info.memoryPaths.length ? <span className="mono">{info.memoryPaths.join(', ')}</span> : '없음'}</div>
          <label>이름<input className="txt" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
          <label>기준 ref<input className="txt mono" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} /></label>
          <label>의존성
            <select value={deps} onChange={(e) => setDeps(e.target.value as Project['deps_strategy'])}>
              <option value="symlink">symlink (메인 트리 node_modules 링크)</option><option value="install">install (매번 설치)</option><option value="none">none</option>
            </select>
          </label>
          <label>기본 템플릿
            <select value={tpl} onChange={(e) => setTpl(e.target.value)}>{snap.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
          <div className="row"><button className="btn primary" type="button" disabled={busy} onClick={() => void add()}>등록</button><button className="btn" type="button" onClick={() => setInfo(null)}>취소</button></div>
        </div>
      )}
    </div>
  );
}

function ProjectItem({ p, snap, ro }: { p: Project; snap: StateSnapshot; ro: boolean }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState({ name: p.name, base_ref: p.base_ref, deps_strategy: p.deps_strategy, heavy: p.heavy_patterns.join('\n'), blocked: p.blocked_patterns.join('\n'), memory: p.memory_paths.join('\n'), tpl: p.default_template_id ?? '' });
  const save = async () => {
    const r = await act(() => api(`/api/projects/${encodeURIComponent(p.id)}`, 'PATCH', {
      name: d.name.trim(), base_ref: d.base_ref.trim(), deps_strategy: d.deps_strategy, heavy_patterns: lines(d.heavy), blocked_patterns: lines(d.blocked), memory_paths: lines(d.memory), default_template_id: d.tpl || null,
    }), '프로젝트를 저장했습니다');
    if (r !== undefined) { await refreshState(); setOpen(false); }
  };
  const del = async () => { const r = await act(() => api(`/api/projects/${encodeURIComponent(p.id)}`, 'DELETE'), '프로젝트를 지웠습니다'); if (r !== undefined) await refreshState(); };
  return (
    <div className="item">
      <div className="item-h">
        <div style={{ minWidth: 0 }}><b>{p.name}</b> <span className="muted small mono">{p.base_ref}</span><div className="muted small mono ellipsis">{p.path}</div></div>
        <div className="row">
          <button className="btn" type="button" onClick={() => setOpen(!open)}>{open ? '닫기' : ro ? '보기' : '수정'}</button>
          {!ro && <ConfirmButton label="삭제" confirmLabel="등록을 지울까요? (저장소는 그대로)" onConfirm={() => void del()} />}
        </div>
      </div>
      {open && (
        <fieldset className="form-grid" disabled={ro}>
          <label>이름<input className="txt" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={60} /></label>
          <label>기준 ref<input className="txt mono" value={d.base_ref} onChange={(e) => setD({ ...d, base_ref: e.target.value })} /></label>
          <label>의존성
            <select value={d.deps_strategy} onChange={(e) => setD({ ...d, deps_strategy: e.target.value as Project['deps_strategy'] })}>
              <option value="symlink">symlink</option><option value="install">install</option><option value="none">none</option>
            </select>
          </label>
          <label>기본 템플릿
            <select value={d.tpl} onChange={(e) => setD({ ...d, tpl: e.target.value })}><option value="">(없음)</option>{snap.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
          <label className="wide">무거운 명령 패턴 <small className="muted">한 줄에 하나 · 정규식</small><textarea className="txt area mono" rows={4} value={d.heavy} onChange={(e) => setD({ ...d, heavy: e.target.value })} /></label>
          <label className="wide">막을 명령 패턴 <small className="muted">한 줄에 하나 · 정규식</small><textarea className="txt area mono" rows={4} value={d.blocked} onChange={(e) => setD({ ...d, blocked: e.target.value })} /></label>
          <label className="wide">참조 메모리 경로 <small className="muted">한 줄에 하나</small><textarea className="txt area mono" rows={2} value={d.memory} onChange={(e) => setD({ ...d, memory: e.target.value })} /></label>
          {!ro && <div className="row wide"><button className="btn primary" type="button" onClick={() => void save()}>저장</button></div>}
        </fieldset>
      )}
    </div>
  );
}

/* ---------- 직속 팀 ---------- */
interface StandingForm { name: string; project_id: string; template_id: string; brief: string; check_command: string; check_interval_sec: string; readable: string[] }

function StandingFields({ f, set, snap, isNew, selfId }: { f: StandingForm; set: (f: StandingForm) => void; snap: StateSnapshot; isNew: boolean; selfId?: string }) {
  const others = snap.teams.filter((t) => t.id !== selfId && t.state !== 'archived');
  return (
    <>
      <label>이름<input className="txt" value={f.name} maxLength={60} onChange={(e) => set({ ...f, name: e.target.value })} /></label>
      {isNew && (
        <>
          <label>프로젝트<select value={f.project_id} onChange={(e) => set({ ...f, project_id: e.target.value })}><option value="">(없음)</option>{snap.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>템플릿<select value={f.template_id} onChange={(e) => set({ ...f, template_id: e.target.value })}>{snap.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        </>
      )}
      <label className="wide">상시 지시서<textarea className="txt area" rows={4} maxLength={8000} value={f.brief} placeholder="예: 에러율 2% 넘으면 최근 배포 팀 기록부터 확인하고 보고" onChange={(e) => set({ ...f, brief: e.target.value })} /></label>
      <label className="wide">점검 명령 <small className="muted">선택 · 종료 코드가 0이 아니면 팀을 깨움</small><input className="txt mono" value={f.check_command} maxLength={2000} placeholder="예: curl -fsS https://example.com/health" onChange={(e) => set({ ...f, check_command: e.target.value })} /></label>
      <label>점검 주기(초)<input className="num" type="number" min={30} max={86400} value={f.check_interval_sec} onChange={(e) => set({ ...f, check_interval_sec: e.target.value })} /></label>
      <div className="wide">
        <div className="small muted">읽을 수 있는 다른 팀 기록{!isNew && ' (저장하면 이 목록으로 바뀜)'}</div>
        <div className="checks">
          {others.length ? others.map((t: TeamView) => (
            <label key={t.id} className="chk"><input type="checkbox" checked={f.readable.includes(t.id)} onChange={(e) => set({ ...f, readable: e.target.checked ? [...f.readable, t.id] : f.readable.filter((x) => x !== t.id) })} />{t.title || t.name}</label>
          )) : <span className="muted small">다른 팀이 없습니다</span>}
        </div>
      </div>
    </>
  );
}

function standingBody(f: StandingForm, isNew: boolean, readableTouched: boolean): Record<string, unknown> {
  const iv = f.check_interval_sec.trim() === '' ? null : Number(f.check_interval_sec);
  const b: Record<string, unknown> = { name: f.name.trim(), brief: f.brief, check_command: f.check_command.trim() || null, check_interval_sec: f.check_command.trim() ? iv : null };
  if (isNew) { b.project_id = f.project_id || null; b.template_id = f.template_id || null; }
  if (isNew || readableTouched) b.readable_team_ids = f.readable;
  return b;
}

function StandingNew({ snap, onDone }: { snap: StateSnapshot; onDone: () => void }) {
  const [f, setF] = useState<StandingForm>({ name: '', project_id: '', template_id: snap.templates.some((t) => t.id === 'tpl-ops') ? 'tpl-ops' : (snap.templates[0]?.id ?? ''), brief: '', check_command: '', check_interval_sec: '300', readable: [] });
  const create = async () => {
    const r = await act(() => api('/api/standing', 'POST', standingBody(f, true, true)), '직속 팀을 만들었습니다');
    if (r !== undefined) { await refreshState(); onDone(); }
  };
  return (
    <div className="sub-panel">
      <h4>새 직속 팀</h4>
      <div className="form-grid">
        <StandingFields f={f} set={setF} snap={snap} isNew />
        <div className="row wide"><button className="btn primary" type="button" disabled={!f.name.trim()} onClick={() => void create()}>만들기</button><button className="btn" type="button" onClick={onDone}>취소</button></div>
      </div>
    </div>
  );
}

function StandingItem({ t, snap, ro }: { t: TeamView; snap: StateSnapshot; ro: boolean }) {
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [f, setF] = useState<StandingForm>({ name: t.name, project_id: t.project_id ?? '', template_id: '', brief: t.standing_brief, check_command: t.check_command ?? '', check_interval_sec: t.check_interval_sec ? String(t.check_interval_sec) : '300', readable: t.readable_team_ids });
  const save = async () => {
    const r = await act(() => api(`/api/standing/${encodeURIComponent(t.id)}`, 'PATCH', standingBody(f, false, touched)), '직속 팀을 저장했습니다');
    if (r !== undefined) { await refreshState(); setOpen(false); }
  };
  const archive = async () => { const r = await act(() => api(`/api/teams/${encodeURIComponent(t.id)}/cancel`, 'POST', {}), '보관했습니다'); if (r !== undefined) await refreshState(); };
  return (
    <div className="item">
      <div className="item-h">
        <div style={{ minWidth: 0 }}><a className="link" href={`#team-${t.id}`}><b>{t.name}</b></a> <span className="muted small">{t.project_name ?? '프로젝트 없음'} · {t.check_command ? `${t.check_interval_sec ?? '?'}초마다 점검` : '점검 없음'}</span></div>
        {!ro && <div className="row"><button className="btn" type="button" onClick={() => setOpen(!open)}>{open ? '닫기' : '수정'}</button><ConfirmButton label="보관" confirmLabel="보관할까요?" onConfirm={() => void archive()} /></div>}
      </div>
      {open && (
        <div className="form-grid">
          <StandingFields f={f} set={(n) => { if (n.readable !== f.readable) setTouched(true); setF(n); }} snap={snap} isNew={false} selfId={t.id} />
          <div className="row wide"><button className="btn primary" type="button" disabled={!f.name.trim()} onClick={() => void save()}>저장</button></div>
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
async function enablePush(vapid: string | null): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('이 브라우저는 웹 푸시를 지원하지 않습니다(아이폰은 홈 화면에 추가한 뒤 열어야 합니다)');
  if (!vapid) throw new Error('서버에 VAPID 키가 없습니다');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림 권한이 거부되었습니다');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapid) }));
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) throw new Error('구독 정보를 만들지 못했습니다');
  const ua = navigator.userAgent;
  const device = (/iPhone|iPad|Android|Macintosh|Windows|Linux/.exec(ua)?.[0] ?? 'browser') + ' · ' + (/Edg|Chrome|Firefox|Safari/.exec(ua)?.[0] ?? '');
  await api('/api/push/subscribe', 'POST', { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, device: device.slice(0, 100) });
}

function TextSetting({ label, sub, value, placeholder, disabled, onSave, mono }: { label: string; sub?: string; value: string; placeholder?: string; disabled: boolean; mono?: boolean; onSave: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="set-col">
      <label>{label}{sub && <small>{sub}</small>}</label>
      <div className="composer">
        <input className={mono ? 'mono' : ''} value={v} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} />
        <button className="btn" type="button" disabled={disabled || v === value} onClick={() => void onSave(v)}>저장</button>
      </div>
    </div>
  );
}

interface RemoteInfo { ownerLogin: string | null; lastRemote: { login: string; at: string } | null }

export function Settings({ snap }: { snap: StateSnapshot }) {
  const ro = snap.access === 'remote';
  const s = snap.settings;
  const [newStanding, setNewStanding] = useState(false);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    api<RemoteInfo>('/api/remote').then(setRemote).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'crit'));
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration('/sw.js').then(async (reg) => setPushState(reg && (await reg.pushManager.getSubscription()) ? 'on' : 'off')).catch(() => setPushState('off'));
    } else setPushState('off');
  }, [s.ownerLogin]);

  const eng = (k: keyof EngineSettings) => (v: number) => saveSettings({ engine: { [k]: v } });
  const standing = snap.teams.filter((t) => t.lifetime === 'standing' && t.state !== 'archived');

  return (
    <>
      <Section title="설정" sub="바꾸면 상단 게이지 기준선과 PO 엔진 판단에 바로 반영">
        {ro && <div className="ro-note">원격 접속에서는 보기만 할 수 있습니다. 설정·프로젝트·직속 팀은 맥에서 바꾸세요.</div>}
        <div className="set-grid">
          <div className="panel"><h3>PO 엔진 · 구간 기준</h3>
            {ENGINE_ROWS.map(([k, l, sub, u]) => <Row key={k} label={l} sub={sub} htmlFor={`set-${k}`}><NumField id={`set-${k}`} value={s.engine[k]} unit={u} disabled={ro} onSave={eng(k)} /></Row>)}
          </div>
          <div className="stack">
            <div className="panel"><h3>동시 실행</h3>
              {CONC_ROWS.map(([k, l, sub, u]) => <Row key={k} label={l} sub={sub} htmlFor={`set-${k}`}><NumField id={`set-${k}`} value={s.engine[k]} unit={u} disabled={ro} onSave={eng(k)} /></Row>)}
            </div>
            <div className="panel"><h3>PO 에이전트</h3>
              <Row label="PO 모델" htmlFor="set-poModel">
                <select id="set-poModel" disabled={ro} value={s.poModel} onChange={(e) => void saveSettings({ poModel: e.target.value as Model })}>
                  <option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
                </select>
              </Row>
              <Row label="팀 구성 자동 승인" sub="켜면 PO 제안을 확인 없이 바로 시작" htmlFor="set-auto">
                <input className="switch" type="checkbox" id="set-auto" disabled={ro} checked={s.autoApprove} onChange={(e) => void saveSettings({ autoApprove: e.target.checked }, e.target.checked ? '자동 승인을 켰습니다' : '자동 승인을 껐습니다')} />
              </Row>
              <Row label="업무 기본 예산" sub="팀마다 승인할 때 바꿀 수 있음" htmlFor="set-budget"><NumField id="set-budget" value={s.defaultBudgetUsd} unit="$" step={0.5} disabled={ro} onSave={(v) => saveSettings({ defaultBudgetUsd: v })} /></Row>
              <Row label="맥락 한도" sub="넘으면 새 PO 세션 + 요약으로 시작" htmlFor="set-ctx"><NumField id="set-ctx" value={s.contextLimitTokens} unit="토큰" step={1000} disabled={ro} onSave={(v) => saveSettings({ contextLimitTokens: v })} /></Row>
            </div>
          </div>
        </div>
      </Section>

      <Section title="프로젝트" sub="팀이 일할 git 저장소">
        <div className="panel stack-s">
          {snap.projects.length ? snap.projects.map((p) => <ProjectItem key={`${p.id}:${JSON.stringify(p)}`} p={p} snap={snap} ro={ro} />) : <div className="muted">등록된 프로젝트가 없습니다.</div>}
          {!ro && <ProjectNew snap={snap} />}
        </div>
      </Section>

      <Section title="직속 팀" right={!ro && !newStanding ? <button className="back" type="button" onClick={() => setNewStanding(true)}>+ 직속 팀 추가</button> : <span>PO를 거치지 않고 바로 지시하는 상시 팀</span>}>
        <div className="panel stack-s">
          {standing.length ? standing.map((t) => <StandingItem key={`${t.id}:${t.name}:${t.standing_brief}:${t.check_command ?? ''}:${t.check_interval_sec ?? ''}`} t={t} snap={snap} ro={ro} />) : <div className="muted">직속 팀이 없습니다.</div>}
          {newStanding && <StandingNew snap={snap} onDone={() => setNewStanding(false)} />}
        </div>
      </Section>

      <div className="set-grid">
        <Section title="알림" sub="사람 확인 필요·완료·실패·장애">
          <div className="panel stack-s">
            <TextSetting label="슬랙 웹훅" sub="비우면 끔" value={s.slackWebhook ?? ''} placeholder="https://hooks.slack.com/services/…" mono disabled={ro} onSave={(v) => saveSettings({ slackWebhook: v.trim() || null })} />
            <div className="set-col">
              <label>웹 푸시 (이 기기)<small>{pushState === 'on' ? '이 기기는 구독 중입니다' : '이 기기에서 알림을 받으려면 켜세요'}</small></label>
              <div className="row">
                <button className="btn primary" type="button" onClick={() => void act(async () => { await enablePush(snap.vapidPublicKey); setPushState('on'); }, '이 기기에서 알림을 받습니다')}>{pushState === 'on' ? '다시 구독' : '알림 켜기'}</button>
                <button className="btn" type="button" onClick={() => void act(() => api('/api/push/test', 'POST', {}), '시험 알림을 보냈습니다')}>시험 알림</button>
              </div>
            </div>
          </div>
        </Section>
        <Section title="원격 접속" sub="Tailscale 로 휴대폰에서 보기">
          <div className="panel stack-s">
            <div className="small">맥에서 <code className="mono">tailscale serve --bg 4312</code> 을 한 번 실행하면 같은 tailnet 의 기기에서 열 수 있습니다. funnel 은 쓰지 마세요.</div>
            <TextSetting label="주인 계정" sub="Tailscale 로그인 (예: me@github)" value={s.ownerLogin ?? ''} mono disabled={ro} onSave={(v) => saveSettings({ ownerLogin: v.trim() || null })} />
            <div className="small muted">
              마지막 원격 접속 시도: {remote?.lastRemote ? <><span className="mono">{remote.lastRemote.login}</span> · {hhmm(remote.lastRemote.at)}</> : '없음'}
              {remote?.lastRemote && remote.lastRemote.login !== s.ownerLogin && !ro && (
                <> <button className="btn" type="button" onClick={() => { const login = remote.lastRemote?.login; if (login) void saveSettings({ ownerLogin: login }, `${login} 을(를) 주인으로 등록했습니다`); }}>이 계정을 주인으로</button></>
              )}
            </div>
          </div>
        </Section>
        <Section title="검색" sub="벡터 검색(선택)">
          <div className="panel stack-s">
            <Row label="임베딩" htmlFor="set-emb">
              <select id="set-emb" disabled={ro} value={s.embedding.provider} onChange={(e) => void saveSettings({ embedding: { provider: e.target.value as SettingsT['embedding']['provider'] } })}>
                <option value="off">끔 (전문 검색만)</option><option value="ollama">Ollama</option><option value="voyage">Voyage</option>
              </select>
            </Row>
            <TextSetting label="모델" value={s.embedding.model} mono disabled={ro} onSave={(v) => saveSettings({ embedding: { model: v.trim() } })} />
            <TextSetting label="주소" value={s.embedding.url} mono disabled={ro} onSave={(v) => saveSettings({ embedding: { url: v.trim() } })} />
            {!ro && <div className="row"><button className="btn" type="button" disabled={indexing} onClick={() => { setIndexing(true); void act(async () => { const r = await api<{ indexed: number }>('/api/search/reindex', 'POST', {}); toast(`${r.indexed}건 색인했습니다`, 'good'); }).finally(() => setIndexing(false)); }}>{indexing ? '색인 중…' : '다시 색인'}</button></div>}
          </div>
        </Section>
      </div>
      <p className="note-sample">Hivelane {snap.version} · {ro ? '원격 접속' : '로컬 접속'}</p>
    </>
  );
}
