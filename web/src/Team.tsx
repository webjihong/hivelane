import { useCallback, useEffect, useRef, useState } from 'react';
import type { Priority, StateSnapshot, TeamDetail, TeamView } from '../../shared/types.ts';
import { MODEL_LABEL } from './art.ts';
import { ChatInput } from './ChatInput.tsx';
import { act, api, clock, debounce, go, onLive, openAgent, refreshState, toast, useBox } from './store.ts';
import { AGENT_STATE_LABEL, ConfirmButton, KIND_LABEL, MODE_LABEL, PRI, RichText, Robot, STATE_LABEL, Steps, agoSec, elapsed, hhmm, lampState, money } from './ui.tsx';

const ACTOR: Record<string, string> = { engine: 'PO 엔진', agent: 'PO', user: '사용자' };

function useTeamDetail(id: string): { detail: TeamDetail | null; missing: boolean; reload: () => void } {
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const reloadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    setDetail(null); setMissing(false);
    const load = async () => {
      try { const d = await api<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`); if (alive) setDetail(d); }
      catch (e) { if (!alive) return; setMissing(true); toast(e instanceof Error ? e.message : String(e), 'crit'); }
    };
    const later = debounce(() => { void load(); }, 400);
    reloadRef.current = () => { void load(); };
    void load();
    const off = onLive((e) => { if (e.type === 'state' || e.teamId === id) later(); });
    return () => { alive = false; off(); };
  }, [id]);
  return { detail, missing, reload: () => reloadRef.current() };
}

function Composer({ placeholder, label, button, onSend, working, onCancel }: { placeholder: string; label: string; button: string; onSend: (text: string) => Promise<boolean>; working?: boolean; onCancel?: () => Promise<unknown> }) {
  return <ChatInput placeholder={placeholder} label={label} button={button} onSend={onSend} working={working} onCancel={onCancel} cancelLabel="진행 취소" />;
}

function DiffModal({ teamId, path, onClose }: { teamId: string; path: string; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ diff: string }>(`/api/teams/${encodeURIComponent(teamId)}/diff?path=${encodeURIComponent(path)}`)
      .then((r) => { if (alive) setDiff(r.diff); })
      .catch((e: unknown) => { toast(e instanceof Error ? e.message : String(e), 'crit'); if (alive) setDiff(''); });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { alive = false; window.removeEventListener('keydown', key); };
  }, [teamId, path, onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-label={`${path} 변경 내용`}>
        <div className="drawer-h"><div><h2 className="mono modal-t">{path}</h2></div><button className="btn" type="button" onClick={onClose}>닫기</button></div>
        <div className="modal-b">
          {diff === null ? <div className="muted">불러오는 중…</div> : !diff ? <div className="muted">변경 내용이 없습니다(또는 worktree 가 정리됨).</div> : (
            <pre className="diff">{diff.split('\n').map((l, i) => {
              const cls = l.startsWith('+++') || l.startsWith('---') ? 'dh' : l.startsWith('+') ? 'da' : l.startsWith('-') ? 'dd' : l.startsWith('@@') ? 'dc' : l.startsWith('diff ') || l.startsWith('index ') ? 'dh' : '';
              return <span key={i} className={cls}>{l}{'\n'}</span>;
            })}</pre>
          )}
        </div>
      </div>
    </>
  );
}

function Workshop({ t }: { t: TeamView }) {
  const live = t.state === 'running';
  return (
    <div className="workshop">
      <div className="ws-h"><h3>작업장 · 로봇을 누르면 작업 내역</h3>
        <div className="ws-legend"><span><i style={{ background: 'var(--m-opus)' }} />Opus</span><span><i style={{ background: 'var(--m-sonnet)' }} />Sonnet</span><span><i style={{ background: 'var(--m-haiku)' }} />Haiku</span><span>점선 = 서브에이전트</span></div></div>
      <div className="ws-floor">
        {t.agents.length === 0 && <div className="muted ws-empty">아직 팀원이 없습니다.</div>}
        {t.agents.map((a, i) => {
          const sub = a.run_mode === 'subagent';
          const step = a.current_step || (a.state === 'idle' ? '대기' : AGENT_STATE_LABEL[a.state]);
          return (
            <span key={a.id} className="ws-pair">
              <button className={`ws-station ${sub ? 'sub' : ''} ${a.state}-st`} type="button" onClick={() => openAgent.set(a.id)}>
                {sub && <span className="sub-tag">PM 세션 안</span>}
                <div className="say">{step}{a.state === 'busy' && <> <span className="typing"><span /><span /><span /></span></>}</div>
                <div className={`av ${a.state}`}><Robot agent={a} /><span className="spk" /><span className="spk" /><span className="spk" /><span className="zz">z z</span><span className="pause-b">II</span></div>
                <div className="bench" />
                <div className="ws-name"><b>{a.role_name}</b><span className={`mdl ${MODEL_LABEL[a.model]}`}>{MODEL_LABEL[a.model]}</span></div>
                <div className="ws-mode">{MODE_LABEL[a.run_mode]} · {AGENT_STATE_LABEL[a.state]}</div>
                <div className="work-bar"><i /></div>
              </button>
              {i < t.agents.length - 1 && <div className={`ws-link ${live ? 'flow' : ''}`} aria-hidden="true" />}
            </span>
          );
        })}
      </div>
    </div>
  );
}

type Msg = { id: number; from_label: string; to_label: string | null; kind: string; body: string; created_at: string };

/** 사용자가 이 팀에 직접 한 지시·답과 그에 대한 PM 의 답. 최신이 위. */
function qaPairs(msgs: Msg[]): { q: Msg; a: Msg | null }[] {
  const sorted = [...msgs].sort((x, y) => x.id - y.id);
  const out: { q: Msg; a: Msg | null }[] = [];
  sorted.forEach((m, i) => {
    if (m.from_label !== '사용자' || (m.kind !== 'instruction' && m.kind !== 'reply')) return;
    const next = sorted.slice(i + 1);
    const stop = next.findIndex((n) => n.from_label === '사용자');
    const window = stop === -1 ? next : next.slice(0, stop);
    out.push({ q: m, a: window.find((n) => n.from_label === 'PM' && (n.kind === 'report' || n.kind === 'question')) ?? null });
  });
  return out.reverse();
}

function QaBox({ msgs, working }: { msgs: Msg[]; working: boolean }) {
  const [more, setMore] = useState(false);
  const pairs = qaPairs(msgs);
  if (!pairs.length) return null;
  const shown = more ? pairs.slice(0, 10) : pairs.slice(0, 1);
  return (
    <div className="qa-box">
      {shown.map(({ q, a }, i) => (
        <div key={q.id} className={`qa${i > 0 ? ' old' : ''}`}>
          <div className="qa-q"><span className="k instruction">{q.kind === 'reply' ? '내 답' : '내 지시'}</span><time className="mono muted">{hhmm(q.created_at)}</time><div className="qa-qt"><RichText text={q.body} /></div></div>
          {a ? (
            <div className="qa-a"><div className="qa-ah"><span className="k report">{a.kind === 'question' ? 'PM 질문' : 'PM 답변'}</span><span className="muted small">{a.to_label === '사용자' ? 'PM → 나' : `PM → ${a.to_label ?? ''} (기록용 보고)`}</span><time className="mono muted">{hhmm(a.created_at)}</time></div><div className="msg-body"><RichText text={a.body} /></div></div>
          ) : (
            <div className="qa-a pending">{i === 0 && working ? <>처리 중 <span className="typing"><span /><span /><span /></span></> : '아직 답이 없습니다'}</div>
          )}
        </div>
      ))}
      {pairs.length > 1 && <button className="btn link-btn" type="button" onClick={() => setMore(!more)}>{more ? '최근 것만 보기' : `이전 문답 ${pairs.length - 1}개 보기`}</button>}
    </div>
  );
}

export function Team({ id, snap }: { id: string; snap: StateSnapshot }) {
  const { detail, missing, reload } = useTeamDetail(id);
  const now = useBox(clock);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const closeDiff = useCallback(() => setDiffPath(null), []);
  // 스냅샷의 팀이 더 자주 갱신되므로 머리 부분은 스냅샷을 우선한다.
  const t = snap.teams.find((x) => x.id === id) ?? detail?.team ?? null;
  const remote = snap.access === 'remote';

  // 화면에 보이는 동안 이 팀의 답을 읽음으로(훅은 이른 반환보다 앞에)
  const msgList = detail?.messages ?? [];
  const lastId = msgList.length ? msgList[msgList.length - 1]!.id : 0;
  const unreadNow = t?.unread ?? 0;
  useEffect(() => {
    if (!lastId || !unreadNow) return;
    const mark = () => { if (document.visibilityState === 'visible') void api('/api/seen', 'POST', { team_id: id, up_to: lastId }).then(() => refreshState()).catch(() => {}); };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [lastId, id, unreadNow]);

  if (!t) return (
    <div className="stack">
      <div><button className="back" type="button" onClick={() => go('home')}>← 업무 목록</button></div>
      <div className="panel muted">{missing ? '팀을 찾을 수 없습니다.' : '불러오는 중…'}</div>
    </div>
  );

  const standing = t.lifetime === 'standing';
  const call = (path: string, body?: unknown, ok?: string) => act(async () => { const r = await api<unknown>(`/api/teams/${encodeURIComponent(t.id)}/${path}`, 'POST', body ?? {}); await refreshState(); reload(); return r; }, ok);
  const finished = t.state === 'done' || t.state === 'failed' || t.state === 'archived';
  const canCompose = !finished && t.state !== 'waiting_human';

  const answer = async (text: string) => (await call('answer', { text }, '답을 보냈습니다')) !== undefined;
  const message = async (text: string) => {
    const r = await act(() => api<{ result: 'delivered' | 'queued' }>(`/api/teams/${encodeURIComponent(t.id)}/message`, 'POST', { text }));
    if (!r) return false;
    toast(r.result === 'delivered' ? '지시를 전달했습니다' : '지시를 받아 두었습니다 · 팀이 돌면 반영', 'good');
    reload();
    return true;
  };

  const msgs = detail?.messages ?? [];
  const check = detail?.checklist ?? [];
  const files = detail?.files ?? [];
  const decs = detail?.decisions ?? [];
  const sums = detail?.summaries ?? [];

  return (
    <>
      <div><button className="back" type="button" onClick={() => go('home')}>← 업무 목록</button></div>
      <div className="team-head">
        <div className="row">
          <span className={`lamp ${lampState(t.state)}`} />
          <span className={`tag ${t.state}`}>{standing && t.state === 'idle' ? '상시 대기' : STATE_LABEL[t.state]}</span>
          {t.priority !== 'normal' && <span className={`chip ${t.priority}`}>{PRI[t.priority]}</span>}
          <span className="chip">{standing ? '직속 팀' : 'PO 팀'}</span>
          {t.pinned && <span className="chip">멈추지 않음</span>}
          {t.project_name && <span className="chip">{t.project_name}</span>}
        </div>
        <h1>{t.title || t.name}</h1>
        {!standing && <Steps stage={t.stage} />}
        <div className="row meta-row">
          {t.branch && <span className="mono muted">{t.branch}</span>}
          <span className="muted">{money(t.cost_usd)}{t.budget_usd != null ? ` / 상한 ${money(t.budget_usd)}` : ''}</span>
          <span className="muted">· 만듦 {hhmm(t.created_at)}{t.started_at ? ` · 시작 ${hhmm(t.started_at)} · ${elapsed(t, now)}` : ''}{t.finished_at ? ` · 끝 ${hhmm(t.finished_at)}` : ''}</span>
        </div>
        {(t.state === 'paused' || t.state === 'queued') && t.paused_reason && <div className="task-note warn">{t.state === 'paused' && t.pause_kind?.startsWith('engine') ? `PO 엔진이 멈춤 · 리소스가 회복되면 자동으로 재개합니다 · ${t.paused_reason}` : t.paused_reason}</div>}
        {t.resume_grace_until && t.state === 'running' && <div className="task-note">직접 재개함 · {hhmm(t.resume_grace_until)}까지 자동 멈춤 안 함</div>}
        {t.state === 'failed' && <div className="task-note crit">실패: {t.error ?? '이유 없음'}</div>}
        {t.error && t.state !== 'failed' && <div className="task-note warn">{t.error}</div>}
        {t.state === 'waiting_human' && (
          <div className="ask-box">
            <div className="q-h">PM의 질문{t.question ? ` · ${hhmm(t.question.asked_at)}` : ''} · 답하면 팀이 바로 다시 가동</div>
            <p>{t.question?.text ?? t.paused_reason ?? '사람 확인이 필요합니다'}</p>
            {!!t.question?.options.length && <div className="row">{t.question.options.map((o) => <button key={o} className="btn" type="button" onClick={() => void answer(o)}>{o}</button>)}</div>}
            <Composer placeholder="직접 답하기" label="PM 질문에 직접 답하기" button="답하기" onSend={answer} />
          </div>
        )}
        {canCompose && (
          <div>
            <div className="composer-h">{standing ? 'PO를 거치지 않고 이 팀에 바로 지시합니다' : '이 팀 PM에게 직접 지시합니다 · PO도 기록을 함께 봅니다'}{t.state === 'paused' || t.state === 'queued' ? ' · 지금은 멈춰 있어 재개될 때 반영' : ''}</div>
            <Composer placeholder={standing ? '예: 지금 api 서버 에러율 확인해줘' : 'PM에게 직접 지시'} label="팀에 직접 지시" button="지시" onSend={message} working={t.state === 'running'} onCancel={() => call('interrupt', {}, '진행 중이던 지시를 취소했습니다')} />
          </div>
        )}
        <QaBox msgs={msgs} working={t.state === 'running'} />
        <div className="row">
          {t.state === 'running' && !standing && <button className="btn" type="button" onClick={() => void call('pause', {}, '멈춤 요청을 보냈습니다')}>멈춤</button>}
          {t.state === 'paused' && <button className="btn primary" type="button" title="15분 동안 엔진이 자동으로 멈추지 않습니다" onClick={() => void call('resume', {}, '재개했습니다 · 15분 동안 자동 멈춤 안 함')}>{t.pause_kind?.startsWith('engine') ? '지금 재개 (15분 보호)' : '재개'}</button>}
          {!standing && !finished && <button className="btn" type="button" aria-pressed={t.pinned} onClick={() => void call('pin', { on: !t.pinned })}>{t.pinned ? '멈추지 않음 해제' : '멈추지 않음'}</button>}
          {!standing && !finished && (
            <label className="inline-sel">우선순위
              <select value={t.priority} onChange={(e) => void call('priority', { priority: e.target.value as Priority })}>
                <option value="urgent">긴급</option><option value="normal">보통</option><option value="low">낮음</option>
              </select>
            </label>
          )}
          {t.state === 'failed' && <button className="btn primary" type="button" onClick={() => void call('retry', {}, '대기열에 다시 넣었습니다')}>다시 시작</button>}
          {!finished && <ConfirmButton label={standing ? '직속 팀 종료' : '중단'} confirmLabel={standing ? '이 직속 팀을 종료할까요? 다시 쓰려면 새로 만들어야 합니다.' : '이 팀을 중단할까요? 진행 중인 턴이 끊깁니다.'} onConfirm={() => void call('cancel', {}, standing ? '직속 팀을 종료했습니다' : '중단했습니다')} />}
          {!standing && (t.state === 'done' || t.state === 'failed') && t.worktree_path && !remote && (
            <ConfirmButton label="worktree 정리" confirmLabel="worktree 폴더를 지웁니다(브랜치는 남김)." onConfirm={() => void call('archive', {}, 'worktree 를 정리했습니다')} />
          )}
        </div>
      </div>

      {standing && (
        <div className="panel standing-info">
          <h3>상시 지시서</h3>
          <div className="brief">{t.standing_brief ? <RichText text={t.standing_brief} /> : <span className="muted">비어 있음 (설정 › 직속 팀에서 수정)</span>}</div>
          <div className="kv">
            <div><small>점검 명령</small><b>{t.check_command ?? '없음'}</b></div>
            <div><small>점검 주기</small><b>{t.check_interval_sec ? `${t.check_interval_sec}초` : '—'}</b></div>
            <div><small>마지막 점검</small><b className={t.last_check_ok === false ? 'crit-t' : t.last_check_ok ? 'good-t' : ''}>{t.last_check_at ? `${hhmm(t.last_check_at)} · ${t.last_check_ok ? '이상 없음' : '이상'}` : '—'}</b></div>
            <div><small>되살림</small><b>{t.revived_count}회</b></div>
            <div><small>생존 확인</small><b>{agoSec(t.last_heartbeat_at, now)}</b></div>
          </div>
        </div>
      )}

      <Workshop t={t} />

      <div className="team-grid">
        <div className="stack">
          <div className="panel"><h3>팀 대화 <small className="muted">최신이 위</small></h3>
            <div className="timeline">
              {msgs.length ? [...msgs].reverse().map((m) => (
                <div key={m.id} className="msg"><time className="mono">{hhmm(m.created_at)}</time>
                  <div className={`bubble ${m.kind}`}>
                    <div className="who"><span className={`k ${m.kind}`}>{KIND_LABEL[m.kind] ?? m.kind}</span><b>{m.from_label}</b>{m.to_label && <span className="muted">→ {m.to_label}</span>}</div>
                    <div className="msg-body"><RichText text={m.body} /></div>
                  </div>
                </div>
              )) : <div className="muted">{detail ? '아직 대화가 없습니다.' : '불러오는 중…'}</div>}
            </div>
          </div>
          {sums.length > 0 && (
            <div className="panel"><h3>요약</h3>
              <div className="timeline">{sums.map((s, i) => <div key={i} className="msg"><time className="mono">{hhmm(s.created_at)}</time><div className="bubble report"><div className="who"><span className="k report">{s.stage}</span></div><div className="msg-body"><RichText text={s.body} /></div></div></div>)}</div>
            </div>
          )}
        </div>
        <div className="stack">
          {!standing && (
            <>
              <div className="panel"><h3>할 일 · 완료 기준</h3>
                <ul className="check">{check.length ? check.map((c) => <li key={c.idx} className={c.done ? 'ok' : ''}><span className="bx">{c.done ? '✓' : ''}</span><span>{c.text}</span></li>) : <li className="muted">아직 없음</li>}</ul>
              </div>
              <div className="panel"><h3>바뀐 파일</h3>
                <ul className="files">{files.length ? files.map((f) => (
                  <li key={f.path}><button type="button" className="file-btn" title={f.path} onClick={() => setDiffPath(f.path)}><span className="p mono">{f.change_type === 'added' ? '＋ ' : f.change_type === 'deleted' ? '－ ' : ''}{f.path.split('/').slice(-2).join('/')}</span></button><span className="mono"><span className="add">+{f.lines_added}</span> <span className="del">−{f.lines_removed}</span></span></li>
                )) : <li className="muted">아직 없음</li>}</ul>
              </div>
            </>
          )}
          <div className="panel"><h3>PO 결정 기록</h3>
            <ul className="decisions">{decs.length ? decs.map((d) => <li key={d.id}><span className="mono muted">{hhmm(d.created_at)}</span><span><b>{ACTOR[d.actor] ?? d.actor}</b> · {d.reason || d.action}</span></li>) : <li className="muted">없음</li>}</ul>
          </div>
        </div>
      </div>
      {diffPath && <DiffModal teamId={t.id} path={diffPath} onClose={closeDiff} />}
    </>
  );
}
