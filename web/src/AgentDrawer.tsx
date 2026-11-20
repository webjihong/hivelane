import { useEffect, useRef, useState } from 'react';
import type { AgentDetail, StateSnapshot } from '../../shared/types.ts';
import { MODEL_LABEL } from './art.ts';
import { api, debounce, onLive, openAgent, toast } from './store.ts';
import { AGENT_STATE_LABEL, MODE_LABEL, hhmm, money } from './ui.tsx';

const EV_LABEL: Record<string, [string, string]> = {
  text: ['말', 'text'], think: ['생각', 'think'], tool_use: ['도구', 'tool'], tool_result: ['결과', 'ok'], tool_error: ['오류', 'err'],
  wait: ['대기', 'wait'], denied: ['거부', 'err'], result: ['턴 끝', 'ok'],
};

export function AgentDrawer({ id, snap }: { id: string; snap: StateSnapshot }) {
  const [d, setD] = useState<AgentDetail | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const close = () => openAgent.set(null);

  useEffect(() => {
    let alive = true;
    setD(null);
    const load = async () => {
      try { const r = await api<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`); if (alive) setD(r); }
      catch (e) { toast(e instanceof Error ? e.message : String(e), 'crit'); if (alive) openAgent.set(null); }
    };
    void load();
    const later = debounce(() => { void load(); }, 1500);
    const off = onLive((e) => {
      if (e.type === 'state') { later(); return; }
      if (e.agentId !== id) return;
      setD((p) => (p && !p.events.some((x) => x.id === e.event.id) ? { ...p, events: [...p.events, { id: e.event.id, kind: e.event.kind, name: e.event.name, body: e.event.body, created_at: e.event.created_at }].slice(-600) } : p));
      if (e.event.kind === 'result') later();
    });
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') openAgent.set(null); };
    window.addEventListener('keydown', key);
    return () => { alive = false; off(); window.removeEventListener('keydown', key); };
  }, [id]);

  useEffect(() => {
    const el = streamRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [d?.events.length]);

  const team = d?.agent.team_id ? snap.teams.find((t) => t.id === d.agent.team_id) : undefined;
  // 상태·현재 단계는 스냅샷 쪽이 더 새롭다.
  const live = team?.agents.find((a) => a.id === id);
  const a = d ? { ...d.agent, ...(live ?? {}) } : null;

  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" aria-label="에이전트 상세">
        <div className="drawer-h">
          <div>
            <h2>{a ? `${a.role_name}${team ? ` · ${team.title || team.name}` : ''}` : '불러오는 중…'}</h2>
            {a && (
              <div className="row drawer-sub">
                <span className={`mdl ${MODEL_LABEL[a.model]}`}>{MODEL_LABEL[a.model]}</span>
                <span className="muted">{MODE_LABEL[a.run_mode]}{a.run_mode === 'subagent' ? ' (PM 세션 안에서 실행)' : ''}</span>
                <span className={`ag-state ${a.state}`}>{AGENT_STATE_LABEL[a.state]}</span>
              </div>
            )}
          </div>
          <button className="btn" type="button" onClick={close}>닫기</button>
        </div>
        {a && d ? (
          <div className="drawer-b">
            {a.current_step && <div className="now-step">지금: {a.current_step}</div>}
            <div className="kv">
              <div><small>입력 토큰</small><b>{a.tokens_in.toLocaleString()}</b></div>
              <div><small>출력 토큰</small><b>{a.tokens_out.toLocaleString()}</b></div>
              <div><small>비용</small><b>{money(a.cost_usd)}</b></div>
              <div><small>session_id</small><b title={a.session_id ?? ''}>{a.session_id ? `${a.session_id.slice(0, 4)}…${a.session_id.slice(-3)}` : a.run_mode === 'subagent' ? 'PM 세션' : '—'}</b></div>
            </div>
            <div>
              <h3 className="d-h">진행 스트림</h3>
              <div className="stream ev-scroll" ref={streamRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
                {d.events.length ? d.events.map((ev) => {
                  const [lab, cls] = EV_LABEL[ev.kind] ?? [ev.kind, 'think'];
                  return (
                    <div key={ev.id} className="ev-row">
                      <span className="t mono">{hhmm(ev.created_at)}</span>
                      <span className={`ty ${cls}`}>{lab}</span>
                      <span className="ev-body">{ev.name && <b className="mono">{ev.name} </b>}{ev.body}</span>
                    </div>
                  );
                }) : <div className="muted">아직 기록이 없습니다.</div>}
              </div>
            </div>
            {d.runs.length > 0 && (
              <div>
                <h3 className="d-h">명령 실행</h3>
                <div className="tbl-wrap"><table className="tbl runs">
                  <thead><tr><th>도구</th><th>명령</th><th>상태</th><th>대기</th></tr></thead>
                  <tbody>{d.runs.map((r) => (
                    <tr key={r.id}><td>{r.tool}</td><td className="mono cmd">{r.command ?? '—'}</td><td>{r.status}</td><td className="mono">{r.waited_ms ? `${Math.round(r.waited_ms / 1000)}초` : '—'}</td></tr>
                  ))}</tbody>
                </table></div>
              </div>
            )}
            <div>
              <button className="d-h fold" type="button" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>{showPrompt ? '▾' : '▸'} 시스템 프롬프트 (템플릿에서 수정)</button>
              {showPrompt && (
                <>
                  <div className="prompt pre">{d.agent.system_prompt || '(비어 있음)'}</div>
                  {d.agent.allowed_tools.length > 0 && <div className="muted tools-l">허용 도구: <span className="mono">{d.agent.allowed_tools.join(', ')}</span></div>}
                </>
              )}
            </div>
          </div>
        ) : <div className="drawer-b muted">불러오는 중…</div>}
      </aside>
    </>
  );
}
