import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { BackupItem, BackupTarget, BackupTargetType, BackupView, StateSnapshot } from '../../shared/types.ts';
import { act, api } from './store.ts';
import { ConfirmButton, Section } from './ui.tsx';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const fmtSize = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)}GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
const fmtAt = (iso: string | null) => { if (!iso) return '-'; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** 파일 이름 hivelane-backup-20261126-030000[-before-restore].tar.gz → 시각 */
const nameAt = (n: string) => { const m = n.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/); return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).toISOString() : null; };
const KIND: Record<BackupTargetType, string> = { local: '이 맥 폴더', webdav: 'NAS (WebDAV)', s3: 'S3' };

/** 설정 › 백업: 주기·보관 · 저장소(이 맥 폴더·시놀로지 NAS·S3) · 백업 목록(열어 보기·복구·지우기) */
export function BackupSection({ snap }: { snap: StateSnapshot }) {
  const ro = snap.access === 'remote';
  const [v, setV] = useState<BackupView | null>(null);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);
  const load = useCallback(() => api<BackupView>('/api/backups').then(setV).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!v?.running) return; const t = setInterval(() => void load(), 2000); return () => clearInterval(t); }, [v?.running, load]);
  if (!v) return <Section title="백업"><div className="panel muted">불러오는 중…</div></Section>;

  const cfg = v.config;
  const save = (patch: Record<string, unknown>, ok: string) => act(async () => { await api('/api/backups/config', 'PUT', patch); await load(); }, ok);
  const runNow = () => act(async () => { const r = await api<{ ok: boolean; error?: string }>('/api/backups/run', 'POST'); await load(); if (!r.ok) throw new Error(r.error ?? '일부 저장소에 올리지 못했습니다(아래 결과 참고)'); }, '백업했습니다');
  const tname = (id: string) => cfg.targets.find((t) => t.id === id)?.name ?? id;
  const last = v.last;

  return (
    <Section title="백업" sub="대화·요약·진행 기록·설정·올린 이미지를 파일 하나로 묶어 저장합니다">
      <div className="acc-list">
        <div className="panel stack-s acc-how">
          <div className="acc-how-h">백업은 이렇게 쓰입니다</div>
          <ol className="acc-how-steps">
            <li><b>백업</b> — 그 순간의 기록 전체를 파일 하나로 저장합니다. 정해 둔 주기마다 저절로, 또는 「지금 백업」으로.</li>
            <li><b>열어 보기</b> — 지금 기록은 그대로 두고, 고른 백업 시점의 팀 대화·진행 기록·총괄 대화를 읽기 전용으로 찾아봅니다. 팀원 진행 기록은 14일 뒤 지워지니 오래된 과정은 백업에서 봅니다.</li>
            <li><b>복구</b> — 모든 기록을 그 시점으로 되돌립니다. 그 뒤 기록은 사라지므로, 복구 직전에 지금 상태를 한 번 더 백업해 둡니다. 서버가 잠깐 다시 시작됩니다.</li>
          </ol>
          <div className="small muted">AI 계정 로그인 정보와 팀 작업 폴더(worktree·코드)는 넣지 않습니다. 코드는 git 에 있습니다.</div>
        </div>

        <div className="panel stack-s">
          <div className="acc-kind-h">자동 백업</div>
          <div className="bk-seg" role="radiogroup" aria-label="자동 백업 주기">
            {(['off', 'daily', 'weekly'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={cfg.schedule.mode === m} className={cfg.schedule.mode === m ? 'on' : ''} disabled={ro} onClick={() => void save({ schedule: { mode: m } }, m === 'off' ? '자동 백업을 껐습니다' : '자동 백업을 켰습니다')}>{{ off: '끄기', daily: '매일', weekly: '매주' }[m]}</button>
            ))}
          </div>
          {cfg.schedule.mode !== 'off' && (
            <div className="bk-when">
              {cfg.schedule.mode === 'weekly' && (
                <select value={cfg.schedule.weekday} disabled={ro} onChange={(e) => void save({ schedule: { weekday: Number(e.target.value) } }, '요일을 바꿨습니다')} aria-label="요일">
                  {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}요일</option>)}
                </select>
              )}
              <input type="time" value={cfg.schedule.time} disabled={ro} onChange={(e) => e.target.value && void save({ schedule: { time: e.target.value } }, '시각을 바꿨습니다')} aria-label="시각" />
              <span className="small muted">에 · 다음 {fmtAt(v.nextAt)}</span>
            </div>
          )}
          <div className="bk-opts">
            <label className="row small" style={{ gap: 6 }}>최근
              <input type="number" min={1} max={365} defaultValue={cfg.keep} key={cfg.keep} disabled={ro} style={{ width: 64 }} aria-label="보관 개수"
                onBlur={(e) => { const n = Math.max(1, Math.min(365, Math.round(Number(e.target.value)))); if (n !== cfg.keep) void save({ keep: n }, `최근 ${n}개만 보관합니다`); }} />
              개만 보관(저장소마다, 오래된 것부터 지움)</label>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={cfg.skipUnchanged} disabled={ro} onChange={(e) => void save({ skipUnchanged: e.target.checked }, '바꿨습니다')} />바뀐 기록이 없으면 자동 백업을 건너뜀</label>
          </div>
          <div className="small muted">맥이 잠들어 있어 예정 시각을 놓치면, 깨어나는 대로 바로 백업합니다.</div>
          <div className="bk-run">
            {!ro && <button className="btn primary" type="button" disabled={v.running || !cfg.targets.some((t) => t.enabled)} onClick={() => void runNow()}>{v.running ? '백업 중…' : '지금 백업'}</button>}
            {last && (
              <span className="small">
                마지막: {fmtAt(last.at)} · {last.skipped ? <span className="muted">바뀐 것 없어 건너뜀</span> : last.ok ? <span className="good-t">성공{last.size ? ` · ${fmtSize(last.size)}` : ''}</span> : <span className="crit-t">실패 — {last.error ?? last.results.filter((r) => !r.ok).map((r) => `${tname(r.target)}: ${r.error}`).join(' · ')}</span>}
              </span>
            )}
          </div>
        </div>

        <div className="panel stack-s">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="acc-kind-h">저장소</div>
            {!ro && !adding && <button className="btn" type="button" onClick={() => setAdding(true)}>+ 저장소 추가</button>}
          </div>
          {!cfg.targets.length && !adding && <div className="small muted">저장소가 없습니다. 「+ 저장소 추가」로 이 맥 폴더·시놀로지 NAS·S3 중 하나 이상을 정하세요(여러 곳에 동시에 올릴 수 있음).</div>}
          {cfg.targets.map((t) => <TargetRow key={t.id} t={t} ro={ro} all={cfg.targets} reload={load} err={v.listErrors[t.id]} />)}
          {adding && <TargetForm onDone={async (t, secret) => { if (t) await save({ targets: [...cfg.targets.map(({ hasSecret: _h, ...x }) => x), t], ...(secret ? { secrets: { [t.id]: secret } } : {}) }, '저장소를 추가했습니다'); setAdding(false); }} />}
        </div>

        <div className="panel stack-s">
          <div className="acc-kind-h">백업 목록</div>
          {v.items.length ? (
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th>시각</th><th>저장소</th><th>크기</th><th /></tr></thead>
              <tbody>{v.items.map((it) => <ItemRow key={`${it.target}:${it.name}`} it={it} tname={tname(it.target)} ro={ro} reload={load} onOpen={(id) => setViewing({ id, name: `${fmtAt(nameAt(it.name))} · ${tname(it.target)}` })} />)}</tbody>
            </table></div>
          ) : <div className="small muted">아직 백업이 없습니다.</div>}
        </div>
      </div>
      {viewing && <BackupViewer id={viewing.id} title={viewing.name} onClose={() => { void api(`/api/backups/view/${viewing.id}`, 'DELETE').catch(() => {}); setViewing(null); }} />}
    </Section>
  );
}

function ItemRow({ it, tname, ro, reload, onOpen }: { it: BackupItem; tname: string; ro: boolean; reload: () => Promise<unknown>; onOpen: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const open = () => act(async () => { setBusy(true); try { const r = await api<{ id: string }>('/api/backups/open', 'POST', { target: it.target, name: it.name }); onOpen(r.id); } finally { setBusy(false); } });
  const restore = () => act(async () => { setBusy(true); try { const r = await api<{ restarting: boolean }>('/api/backups/restore', 'POST', { target: it.target, name: it.name }); if (!r.restarting) throw new Error('복구본을 준비했습니다. 서버를 다시 시작하면 적용됩니다'); } finally { setBusy(false); } }, '복구합니다. 서버가 다시 시작되면 화면을 새로고침하세요');
  const del = () => act(async () => { await api(`/api/backups/${encodeURIComponent(it.target)}/${encodeURIComponent(it.name)}`, 'DELETE'); await reload(); }, '백업을 지웠습니다');
  const tag = it.name.includes('before-restore') ? <span className="chip" style={{ marginLeft: 6 }}>복구 직전</span> : null;
  return (
    <tr>
      <td>{fmtAt(nameAt(it.name) ?? it.at)}{tag}</td>
      <td>{tname}</td>
      <td className="mono">{fmtSize(it.size)}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button className="btn" type="button" disabled={busy} onClick={() => void open()}>{busy ? '받는 중…' : '열어 보기'}</button>{' '}
        {!ro && <ConfirmButton label="복구" confirmLabel="모든 기록을 이 시점으로 되돌릴까요?" onConfirm={() => void restore()} disabled={busy} />}{' '}
        {!ro && <ConfirmButton label="지우기" className="btn ghost" confirmLabel="이 백업을 지울까요?" onConfirm={() => void del()} />}
      </td>
    </tr>
  );
}

function TargetRow({ t, ro, all, reload, err }: { t: BackupTarget & { hasSecret: boolean }; ro: boolean; all: (BackupTarget & { hasSecret: boolean })[]; reload: () => Promise<unknown>; err?: string }) {
  const [result, setResult] = useState<string | null>(null);
  const strip = (x: BackupTarget & { hasSecret?: boolean }) => { const { hasSecret: _h, ...rest } = x; return rest; };
  const put = (targets: BackupTarget[], ok: string) => act(async () => { await api('/api/backups/config', 'PUT', { targets }); await reload(); }, ok);
  const test = () => act(async () => { setResult('시험 중…'); const r = await api<{ ok: boolean; error?: string }>('/api/backups/test', 'POST', { target: strip(t) }); setResult(r.ok ? '✓ 연결됨(작은 파일을 올리고 지웠습니다)' : `✗ ${r.error}`); });
  const where = t.type === 'local' ? t.path : t.type === 'webdav' ? `${t.url}${t.username ? ` · ${t.username}` : ''}` : `${t.endpoint ? `${t.endpoint} · ` : ''}${t.bucket}${t.prefix ? `/${t.prefix}` : ''} · ${t.region || 'us-east-1'}`;
  return (
    <div className="bk-target">
      <div style={{ minWidth: 0 }}>
        <b>{t.name}</b> <span className="chip">{t.type === 'local' && t.path?.startsWith('/Volumes/') ? 'NAS (연결한 폴더)' : KIND[t.type]}</span>
        {!t.enabled && <span className="chip" style={{ marginLeft: 4 }}>꺼짐</span>}
        <div className="small muted mono ellipsis">{where}</div>
        {t.type !== 'local' && !t.hasSecret && <div className="small crit-t">{t.type === 's3' ? '비밀 키' : '비밀번호'}가 키체인에 없습니다 — 지우고 다시 추가하세요</div>}
        {err && <div className="small crit-t">목록을 읽지 못했습니다: {err}</div>}
        {result && <div className="small">{result}</div>}
      </div>
      {!ro && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn" type="button" onClick={() => void test()}>연결 시험</button>
          <button className="btn ghost" type="button" onClick={() => void put(all.map((x) => strip(x.id === t.id ? { ...x, enabled: !x.enabled } : x)), t.enabled ? '껐습니다' : '켰습니다')}>{t.enabled ? '끄기' : '켜기'}</button>
          <ConfirmButton label="지우기" className="btn ghost" confirmLabel="저장소 설정을 지울까요?(올린 백업 파일은 그대로)" onConfirm={() => void put(all.filter((x) => x.id !== t.id).map(strip), '저장소를 지웠습니다')} />
        </div>
      )}
    </div>
  );
}

type Kind = 'local' | 'nas' | 's3';
function TargetForm({ onDone }: { onDone: (t: BackupTarget | null, secret?: string) => Promise<void> }) {
  const [kind, setKind] = useState<Kind>('local');
  const [nasVia, setNasVia] = useState<'folder' | 'webdav'>('folder');
  const [f, setF] = useState<Record<string, string>>({ name: '', path: '~/.hivelane/backups', url: '', username: '', bucket: '', region: 'ap-northeast-2', endpoint: '', prefix: 'hivelane', accessKeyId: '' });
  const [secret, setSecret] = useState('');
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const set = (k: string, val: string) => setF((p) => ({ ...p, [k]: val }));
  const type: BackupTargetType = kind === 's3' ? 's3' : kind === 'nas' && nasVia === 'webdav' ? 'webdav' : 'local';
  const build = (): BackupTarget => ({
    id: `bk-${Date.now().toString(36)}`, type, enabled: true,
    name: f.name!.trim() || (kind === 'local' ? '이 맥' : kind === 'nas' ? '시놀로지 NAS' : 'S3'),
    ...(type === 'local' ? { path: f.path!.trim() } : {}),
    ...(type === 'webdav' ? { url: f.url!.trim(), username: f.username!.trim() } : {}),
    ...(type === 's3' ? { bucket: f.bucket!.trim(), region: f.region!.trim(), endpoint: f.endpoint!.trim() || undefined, prefix: f.prefix!.trim(), accessKeyId: f.accessKeyId!.trim() } : {}),
  });
  const test = () => act(async () => { setTestMsg('시험 중…'); const r = await api<{ ok: boolean; error?: string }>('/api/backups/test', 'POST', { target: build(), secret: secret || undefined }); setTestMsg(r.ok ? '✓ 연결됨' : `✗ ${r.error}`); });
  const field = (k: string, label: string, ph: string, extra: ReactNode = null, inputType = 'text') => (
    <label className="bk-field"><span>{label}</span><input className="acc-name-in" type={inputType} value={inputType === 'password' ? secret : f[k]} placeholder={ph} autoComplete="off" onChange={(e) => (inputType === 'password' ? setSecret(e.target.value) : set(k, e.target.value))} />{extra}</label>
  );
  return (
    <div className="bk-form stack-s">
      <div className="acc-kinds">
        {([['local', '이 맥 폴더', '가장 간단 · 맥이 고장 나면 같이 잃음'], ['nas', '시놀로지 NAS', '집·사무실 안에 보관 · 연결한 폴더 또는 WebDAV'], ['s3', 'AWS S3', '맥 밖에 보관 · S3 호환(시놀로지 C2·MinIO)도']] as const).map(([k, t, s]) => (
          <button key={k} type="button" className={`acc-kind${kind === k ? ' on' : ''}`} onClick={() => { setKind(k); setTestMsg(null); if (k === 'nas') set('path', '/Volumes/'); if (k === 'local') set('path', '~/.hivelane/backups'); }}>
            <span className="acc-kind-t">{t}</span><span className="acc-kind-s">{s}</span>
          </button>
        ))}
      </div>
      {kind === 'nas' && (
        <div className="bk-seg">
          <button type="button" className={nasVia === 'folder' ? 'on' : ''} onClick={() => { setNasVia('folder'); set('path', '/Volumes/'); }}>Finder 로 연결한 폴더</button>
          <button type="button" className={nasVia === 'webdav' ? 'on' : ''} onClick={() => setNasVia('webdav')}>WebDAV 주소</button>
        </div>
      )}
      {field('name', '이름', kind === 'local' ? '예: 이 맥' : kind === 'nas' ? '예: 사무실 NAS' : '예: S3 서울')}
      {type === 'local' && field('path', '폴더', kind === 'nas' ? '/Volumes/공유폴더/hivelane-backup' : '~/.hivelane/backups', kind === 'nas' ? <small className="muted">Finder › 이동 › 서버에 연결(smb://NAS주소)로 연결한 뒤 /Volumes/공유폴더 아래 경로를 적습니다. 로그인할 때 자동 연결하려면 시스템 설정 › 일반 › 로그인 항목에 넣으세요.</small> : null)}
      {type === 'webdav' && <>
        {field('url', 'WebDAV 주소', 'https://nas.local:5006/backup/hivelane', <small className="muted">시놀로지 패키지 센터에서 「WebDAV Server」를 켜면 HTTPS 5006 포트로 열립니다.</small>)}
        {field('username', '사용자', 'NAS 사용자 이름')}
        {field('secret', '비밀번호', '맥 키체인에 저장', null, 'password')}
      </>}
      {type === 's3' && <>
        {field('bucket', '버킷', 'my-hivelane-backup')}
        {field('region', '지역', 'ap-northeast-2(서울)')}
        {field('prefix', '폴더(접두사)', 'hivelane')}
        {field('accessKeyId', '접근 키 ID', 'AKIA…', <small className="muted">이 버킷만 쓰는 IAM 사용자를 만드는 것을 권합니다(PutObject·GetObject·DeleteObject·ListBucket).</small>)}
        {field('secret', '비밀 접근 키', '맥 키체인에 저장', null, 'password')}
        {field('endpoint', 'S3 호환 주소(선택)', 'AWS 면 비움 · 예: https://nas.local:9000')}
      </>}
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={() => void test()}>연결 시험</button>
        <button className="btn primary" type="button" onClick={() => void onDone(build(), secret || undefined)}>추가</button>
        <button className="btn ghost" type="button" onClick={() => void onDone(null)}>취소</button>
        {testMsg && <span className="small">{testMsg}</span>}
      </div>
    </div>
  );
}

/** 백업 열어 보기(읽기 전용): 팀 목록 → 팀 대화·요약·진행 기록 · 총괄 대화 */
function BackupViewer({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  type T = { id: string; name: string; state: string; lifetime: string; created_at: string; finished_at: string | null; messages: number };
  type M = { id: number; from_label?: string; to_label?: string | null; kind?: string; role?: string; role_name?: string | null; name?: string | null; stage?: string; body: string; created_at: string };
  const [q, setQ] = useState('');
  const [teams, setTeams] = useState<T[]>([]);
  const [sel, setSel] = useState<string>('');
  const [tab, setTab] = useState<'messages' | 'summaries' | 'events'>('messages');
  const [detail, setDetail] = useState<{ team: Record<string, unknown> | null; messages: M[]; summaries: M[]; events: M[] } | null>(null);
  const [po, setPo] = useState<M[] | null>(null);
  useEffect(() => { const t = setTimeout(() => void api<{ teams: T[] }>(`/api/backups/view/${id}/teams?q=${encodeURIComponent(q)}`).then((r) => setTeams(r.teams)).catch(() => {}), 250); return () => clearTimeout(t); }, [id, q]);
  useEffect(() => {
    if (sel === 'po') { void api<{ chat: M[] }>(`/api/backups/view/${id}/po`).then((r) => setPo(r.chat)).catch(() => {}); return; }
    if (sel) void api<typeof detail>(`/api/backups/view/${id}/teams/${encodeURIComponent(sel)}`).then(setDetail).catch(() => {});
  }, [id, sel]);
  const rows: M[] = sel === 'po' ? po ?? [] : detail ? detail[tab] : [];
  return (
    <div className="bk-viewer" role="dialog" aria-label="백업 열어 보기">
      <div className="bk-viewer-in">
        <div className="bk-viewer-h">
          <div><b>백업 열어 보기</b> <span className="small muted">{title} · 읽기 전용(지금 기록은 그대로)</span></div>
          <button className="btn" type="button" onClick={onClose}>닫기</button>
        </div>
        <div className="bk-viewer-b">
          <div className="bk-viewer-l">
            <input className="acc-name-in" value={q} placeholder="팀 이름·대화 내용 찾기" onChange={(e) => setQ(e.target.value)} />
            <button type="button" className={`bk-team${sel === 'po' ? ' on' : ''}`} onClick={() => setSel('po')}><b>총괄 대화</b></button>
            {teams.map((t) => (
              <button key={t.id} type="button" className={`bk-team${sel === t.id ? ' on' : ''}`} onClick={() => { setSel(t.id); setTab('messages'); }}>
                <b className="ellipsis">{t.name}</b>
                <span className="small muted">{t.lifetime === 'standing' ? '직속 팀' : t.state} · {fmtAt(t.created_at)} · 대화 {t.messages}</span>
              </button>
            ))}
            {!teams.length && <div className="small muted">팀이 없습니다.</div>}
          </div>
          <div className="bk-viewer-r">
            {!sel && <div className="muted">왼쪽에서 팀이나 총괄 대화를 고르세요.</div>}
            {sel && sel !== 'po' && (
              <div className="acc-tabs">
                {(['messages', 'summaries', 'events'] as const).map((k) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{{ messages: '대화', summaries: '요약', events: '진행 기록' }[k]} {detail ? <span className="acc-pct">{detail[k].length}</span> : null}</button>)}
              </div>
            )}
            <div className="bk-msgs">
              {rows.map((m) => (
                <div key={m.id} className="bk-msg">
                  <div className="small muted">{fmtAt(m.created_at)} · {m.role ? (m.role === 'user' ? '사용자' : '총괄') : m.stage ? `[${m.stage}]` : m.from_label ? `${m.from_label}${m.to_label ? ` → ${m.to_label}` : ''}${m.kind ? ` (${m.kind})` : ''}` : `${m.role_name ?? ''} · ${m.kind}${m.name ? ` ${m.name}` : ''}`}</div>
                  <div className="bk-body">{m.body}</div>
                </div>
              ))}
              {sel && !rows.length && <div className="small muted">내용이 없습니다.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
