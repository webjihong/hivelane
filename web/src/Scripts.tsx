import { useEffect, useRef, useState } from 'react';
import type { ScriptRunView, ScriptView, StateSnapshot } from '../../shared/types.ts';
import { act, api, clock, onLive, refreshState, useBox } from './store.ts';
import { NewBelow, useStickToBottom } from './stick.tsx';
import { hhmm } from './ui.tsx';

function dur(a: string, b: string | null, now: number): string {
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : now) - Date.parse(a)) / 1000));
  return s < 60 ? `${s}초` : s < 3600 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

/** 실행 출력: 저장된 출력 + 실시간으로 들어오는 줄 */
function Console({ runId, onClose }: { runId: number; onClose: () => void }) {
  const [run, setRun] = useState<ScriptRunView | null>(null);
  const [out, setOut] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  const sb = useStickToBottom(ref as unknown as React.RefObject<HTMLDivElement>, !!run);
  const now = useBox(clock);
  useEffect(() => {
    let alive = true;
    const load = () => api<ScriptRunView>(`/api/script-runs/${runId}`).then((r) => { if (alive) { setRun(r); setOut(r.output ?? ''); } }).catch(() => {});
    void load();
    const off = onLive((e) => {
      if (e.type === 'script_out' && e.runId === runId) setOut((o) => o + e.chunk);
      if (e.type === 'state') void api<ScriptRunView>(`/api/script-runs/${runId}`).then((r) => { if (alive) setRun((p) => (p?.finished_at ? p : { ...r, output: undefined })); if (alive && r.finished_at) setOut(r.output ?? ''); }).catch(() => {});
    });
    return () => { alive = false; off(); };
  }, [runId]);
  const done = !!run?.finished_at;
  return (
    <div className="sc-console">
      <div className="sc-con-h">
        <span className={`sc-status ${!run ? '' : !done ? 'run' : run.exit_code === 0 ? 'ok' : 'bad'}`}>{!run ? '불러오는 중' : !done ? '실행 중' : run.exit_code === 0 ? '성공' : `실패 · 코드 ${run.exit_code}`}</span>
        {run && <span className="muted small mono">{hhmm(run.started_at)} · {dur(run.started_at, run.finished_at, now)} · {run.by === 'remote' ? '원격' : '맥'} · {run.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>}
        <button type="button" className="link-btn" onClick={() => void navigator.clipboard?.writeText(out)}>복사</button>
        <button type="button" className="link-btn" onClick={onClose}>닫기</button>
      </div>
      <div className="tc-scroll">
        <pre ref={ref} className="sc-out mono" onScroll={sb.onScroll}>{out || (done ? '(출력 없음)' : '')}</pre>
        <NewBelow show={sb.newBelow} onClick={sb.jump} />
      </div>
    </div>
  );
}

function ScriptForm({ snap, init, onDone }: { snap: StateSnapshot; init?: ScriptView; onDone: () => void }) {
  const [f, setF] = useState({ project_id: init?.project_id ?? snap.projects[0]?.id ?? null, name: init?.name ?? '', command: init?.command ?? '', cwd: init?.cwd ?? '', confirm: init?.confirm ?? false });
  const [npm, setNpm] = useState<{ dir: string; name: string; command: string }[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { setNpm(null); if (f.project_id) void api<{ dir: string; name: string; command: string }[]>(`/api/projects/${encodeURIComponent(f.project_id)}/npm-scripts`).then(setNpm).catch(() => setNpm([])); }, [f.project_id]);
  const save = async () => {
    const r = await act(() => (init ? api(`/api/scripts/${init.id}`, 'PATCH', f) : api('/api/scripts', 'POST', f)), init ? '고쳤습니다' : '등록했습니다');
    if (r !== undefined) { await refreshState(); onDone(); }
  };
  const del = async () => { const r = await act(() => api(`/api/scripts/${init!.id}`, 'DELETE'), '지웠습니다'); if (r !== undefined) { await refreshState(); onDone(); } };
  const picks = (npm ?? []).filter((s) => !q || `${s.dir} ${s.name} ${s.command}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <div className="panel sc-form">
      <h3>{init ? '스크립트 고치기' : '새 스크립트'}</h3>
      <div className="form-grid">
        <label>프로젝트
          <select value={f.project_id ?? ''} onChange={(e) => setF({ ...f, project_id: e.target.value || null })}>
            {snap.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="">(프로젝트 없음 · 홈 폴더)</option>
          </select>
        </label>
        <label>이름<input className="txt" value={f.name} maxLength={60} placeholder="예: dev DB 동기화" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="wide">명령 <small className="muted">zsh 로 실행 · 여러 줄 가능</small><textarea className="txt area mono" rows={3} value={f.command} placeholder="예: npm run db:dev:sync" onChange={(e) => setF({ ...f, command: e.target.value })} /></label>
        <label>실행 폴더 <small className="muted">비우면 프로젝트 폴더 · 상대 경로 가능</small><input className="txt mono" value={f.cwd} placeholder="예: apps/api" onChange={(e) => setF({ ...f, cwd: e.target.value })} /></label>
        <label className="chk"><input type="checkbox" checked={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.checked })} /> 실행 전에 한 번 더 확인(배포·DB 등)</label>
      </div>
      {f.project_id && (
        <details className="sc-npm">
          <summary>package.json 스크립트에서 고르기 {npm ? `(${npm.length})` : ''}</summary>
          <input className="txt" value={q} placeholder="찾기 (예: db, test, build)" onChange={(e) => setQ(e.target.value)} />
          <div className="sc-npm-list">
            {picks.map((s, i) => (
              <button key={i} type="button" className="sc-npm-i" onClick={() => setF({ ...f, name: f.name || `${s.dir ? `${s.dir} · ` : ''}${s.name}`, command: `npm run ${s.name}`, cwd: s.dir, confirm: f.confirm || /prod|deploy|publish|migrat|db:/.test(s.name) })}>
                <b className="mono">{s.dir ? `${s.dir}/` : ''}{s.name}</b><span className="muted mono">{s.command}</span>
              </button>
            ))}
            {npm && !picks.length && <div className="muted small">없음</div>}
          </div>
        </details>
      )}
      <div className="row">
        <button className="btn primary" type="button" disabled={!f.name.trim() || !f.command.trim()} onClick={() => void save()}>{init ? '저장' : '등록'}</button>
        <button className="btn" type="button" onClick={onDone}>취소</button>
        {init && <button className="btn danger" type="button" style={{ marginLeft: 'auto' }} onClick={() => void del()}>지우기</button>}
      </div>
    </div>
  );
}

function ScriptCard({ s, snap, open, setOpen, onEdit }: { s: ScriptView; snap: StateSnapshot; open: number | null; setOpen: (id: number | null) => void; onEdit: () => void }) {
  const now = useBox(clock);
  const [ask, setAsk] = useState(false);
  const [hist, setHist] = useState<ScriptRunView[] | null>(null);
  useEffect(() => { if (!ask) return; const t = setTimeout(() => setAsk(false), 5000); return () => clearTimeout(t); }, [ask]);
  const running = s.running_run_id;
  const last = s.last_run;
  const run = async () => {
    if (s.confirm && !ask) { setAsk(true); return; }
    setAsk(false);
    const r = await act(() => api<{ run_id: number }>(`/api/scripts/${s.id}/run`, 'POST', {}));
    if (r) { setOpen(r.run_id); await refreshState(); }
  };
  const stop = () => act(() => api(`/api/script-runs/${running}/stop`, 'POST', {}), '멈춤 신호를 보냈습니다');
  return (
    <div className={`sc-card${running ? ' running' : ''}`}>
      <div className="sc-row">
        <div className="sc-main">
          <div className="sc-t"><b>{s.name}</b>{s.confirm && <span className="chip">확인 필요</span>}</div>
          <div className="sc-cmd mono" title={s.command}>{s.cwd ? <span className="muted">{s.cwd}$ </span> : null}{s.command.split('\n')[0]}{s.command.includes('\n') ? ' …' : ''}</div>
          <div className="sc-last small">
            {running ? <span className="sc-status run">실행 중 · {last ? dur(last.started_at, null, now) : ''}</span>
              : last ? <span className={`sc-status ${last.exit_code === 0 ? 'ok' : 'bad'}`}>{last.exit_code === 0 ? '✓ 성공' : `✕ 실패(${last.exit_code})`}</span> : <span className="muted">아직 안 돌림</span>}
            {last && !running && <span className="muted"> · {hhmm(last.started_at)} · {dur(last.started_at, last.finished_at, now)}</span>}
            {last && <button type="button" className="link-btn" onClick={() => setOpen(open === (running ?? last.id) ? null : (running ?? last.id))}>{open === (running ?? last.id) ? '출력 닫기' : '출력'}</button>}
            <button type="button" className="link-btn" onClick={() => void (hist ? setHist(null) : api<ScriptRunView[]>(`/api/scripts/${s.id}/runs`).then(setHist))}>{hist ? '기록 닫기' : '기록'}</button>
            {snap.access !== 'remote' && <button type="button" className="link-btn" onClick={onEdit}>고치기</button>}
          </div>
        </div>
        {running
          ? <button type="button" className="btn ci-cancel sc-btn" onClick={() => void stop()}>멈춤</button>
          : <button type="button" className={`btn ${ask ? 'danger' : 'primary'} sc-btn`} onClick={() => void run()}>{ask ? '정말 실행?' : '실행'}</button>}
      </div>
      {hist && (
        <div className="sc-hist">
          {hist.length ? hist.map((h) => (
            <button key={h.id} type="button" className="sc-hist-i" onClick={() => setOpen(h.id)}>
              <span className={`sc-status ${h.finished_at == null ? 'run' : h.exit_code === 0 ? 'ok' : 'bad'}`}>{h.finished_at == null ? '●' : h.exit_code === 0 ? '✓' : `✕${h.exit_code}`}</span>
              <span className="mono">{new Date(h.started_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="muted">{dur(h.started_at, h.finished_at, now)} · {h.by === 'remote' ? '원격' : '맥'}</span>
            </button>
          )) : <div className="muted small">기록 없음</div>}
        </div>
      )}
      {open != null && (open === running || open === last?.id || hist?.some((h) => h.id === open)) && <Console key={open} runId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function Scripts({ snap }: { snap: StateSnapshot }) {
  const [form, setForm] = useState<ScriptView | 'new' | null>(null);
  const [open, setOpen] = useState<Record<string, number | null>>({});
  const local = snap.access !== 'remote';
  const groups = [...snap.projects.map((p) => ({ id: p.id as string | null, name: p.name })), { id: null, name: '프로젝트 없음' }]
    .map((g) => ({ ...g, items: snap.scripts.filter((s) => s.project_id === g.id) })).filter((g) => g.items.length);
  return (
    <div className="sc">
      <header className="nw-h">
        <h1>스크립트</h1>
        <span className="muted">맥에서 돌리고 결과를 여기서 봅니다 · 휴대폰에서도 실행</span>
        {local && !form && <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setForm('new')}>새 스크립트</button>}
      </header>
      {!local && <div className="ro-note">원격에서는 실행·멈춤·출력 보기만 됩니다. 등록·수정은 맥에서.</div>}
      {form && <ScriptForm snap={snap} init={form === 'new' ? undefined : form} onDone={() => setForm(null)} />}
      {groups.length ? groups.map((g) => (
        <section key={g.id ?? 'none'} className="nw-sec">
          <h2>{g.name}</h2>
          <div className="sc-list">{g.items.map((s) => <ScriptCard key={s.id} s={s} snap={snap} open={open[s.id] ?? null} setOpen={(id) => setOpen((o) => ({ ...o, [s.id]: id }))} onEdit={() => setForm(s)} />)}</div>
        </section>
      )) : !form && <div className="nw-empty">아직 등록한 스크립트가 없습니다. {local ? '「새 스크립트」에서 명령을 등록하거나 package.json 스크립트를 골라 바로 등록하세요.' : '맥에서 등록하세요.'}</div>}
    </div>
  );
}
