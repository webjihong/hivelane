import { useCallback, useEffect, useRef, useState } from 'react';
import type { Priority, StateSnapshot, TeamDetail, TeamView } from '../../shared/types.ts';
import { MODEL_LABEL } from './art.ts';
import { ChatInput } from './ChatInput.tsx';
import { PrRow } from './Prs.tsx';
import { act, api, clock, debounce, go, onLive, openAgent, refreshState, toast, useBox } from './store.ts';
import { t } from './i18n.ts';
import { AGENT_STATE_LABEL, ConfirmButton, KIND_LABEL, MODE_LABEL, PRI, RichText, Robot, STATE_LABEL, Steps, agoSec, elapsed, hhmm, lampState, money, whoLabel } from './ui.tsx';

/** 「팀 정리」로 끝난 팀에 보낼 수 있는 업무 팀 상태(서버 Orchestrator.CLOSABLE 과 같게) */
const CLOSABLE = ['done', 'failed', 'paused', 'queued', 'waiting_human'];

const ACTOR: Record<string, string> = { engine: t('총괄 엔진'), agent: t('총괄'), user: t('사용자') };

export function useTeamDetail(id: string): { detail: TeamDetail | null; missing: boolean; reload: () => void } {
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
    const off = onLive((e) => { if (e.type === 'state' || (e.type === 'agent_event' && e.teamId === id)) later(); });
    return () => { alive = false; off(); };
  }, [id]);
  return { detail, missing, reload: () => reloadRef.current() };
}

function Composer({ placeholder, label, button, onSend, working, onCancel }: { placeholder: string; label: string; button: string; onSend: (text: string) => Promise<boolean>; working?: boolean; onCancel?: () => Promise<unknown> }) {
  return <ChatInput placeholder={placeholder} label={label} button={button} onSend={onSend} working={working} onCancel={onCancel} cancelLabel={t('진행 취소')} />;
}

function DiffModal({ teamId, path, onClose }: { teamId: string; path: string; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [fromPatch, setFromPatch] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ diff: string; from_patch?: boolean }>(`/api/teams/${encodeURIComponent(teamId)}/diff?path=${encodeURIComponent(path)}`)
      .then((r) => { if (alive) { setDiff(r.diff); setFromPatch(!!r.from_patch); } })
      .catch((e: unknown) => { toast(e instanceof Error ? e.message : String(e), 'crit'); if (alive) setDiff(''); });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { alive = false; window.removeEventListener('keydown', key); };
  }, [teamId, path, onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-label={t('{path} 변경 내용', { path })}>
        <div className="drawer-h"><div><h2 className="mono modal-t">{path}</h2>{fromPatch && <div className="drawer-sub muted">{t('worktree 정리 때 남겨 둔 패치에서 보여 줍니다')}</div>}</div><button className="btn" type="button" onClick={onClose}>{t('닫기')}</button></div>
        <div className="modal-b">
          {diff === null ? <div className="muted">{t('불러오는 중…')}</div> : !diff ? <div className="muted">{t('변경 내용이 없습니다(또는 패치 보관 전에 worktree 가 정리됨).')}</div> : (
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

/** 팀 에이전트 목록: 누르면 작업 내역(스트림·토큰·프롬프트) */
function Agents({ tm }: { tm: TeamView }) {
  return (
    <div className="panel"><h3>{t('에이전트')} <small className="muted">{t('누르면 작업 내역')}</small></h3>
      <div className="ag-list">
        {tm.agents.length === 0 && <div className="muted">{t('아직 팀원이 없습니다.')}</div>}
        {tm.agents.map((a) => {
          const sub = a.run_mode === 'subagent';
          const step = a.current_step || (a.state === 'idle' ? t('대기') : AGENT_STATE_LABEL[a.state]);
          return (
            <button key={a.id} className={`ag-row ${a.state}`} type="button" onClick={() => openAgent.set(a.id)}>
              <span className={`ag-av ${MODEL_LABEL[a.model]}`} aria-hidden="true">{a.role_name.slice(0, 2)}</span>
              <span className="ag-main">
                <span className="ag-t"><b>{a.role_name}</b><span className={`mdl ${MODEL_LABEL[a.model]}`}>{MODEL_LABEL[a.model]}</span><span className="muted small">{sub ? t('서브에이전트 · PM 세션 안') : MODE_LABEL[a.run_mode]}</span></span>
                <span className="ag-step">{a.state === 'busy' && <span className="sdot run" />}{step}</span>
              </span>
              <span className="ag-num mono muted">{money(a.cost_usd)}<br />{Math.round((a.tokens_in + a.tokens_out) / 1000)}k</span>
            </button>
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
          <div className="qa-q"><span className="k instruction">{q.kind === 'reply' ? t('내 답') : t('내 지시')}</span><time className="mono muted">{hhmm(q.created_at)}</time><div className="qa-qt"><RichText text={q.body} /></div></div>
          {a ? (
            <div className="qa-a"><div className="qa-ah"><span className="k report">{a.kind === 'question' ? t('PM 질문') : t('PM 답변')}</span><span className="muted small">{a.to_label === '사용자' ? t('PM → 나') : t('PM → {who} (기록용 보고)', { who: whoLabel(a.to_label) })}</span><time className="mono muted">{hhmm(a.created_at)}</time></div><div className="msg-body"><RichText text={a.body} /></div></div>
          ) : (
            <div className="qa-a pending">{i === 0 && working ? <>{t('처리 중')} <span className="typing"><span /><span /><span /></span></> : t('아직 답이 없습니다')}</div>
          )}
        </div>
      ))}
      {pairs.length > 1 && <button className="btn link-btn" type="button" onClick={() => setMore(!more)}>{more ? t('최근 것만 보기') : t('이전 문답 {n}개 보기', { n: pairs.length - 1 })}</button>}
    </div>
  );
}

/** embedded: 팀 채널의 「팀 상세」 칸 안에서 쓴다(대화·지시·질문은 채널이 맡으므로 숨김) */
export function Team({ id, snap, embedded = false }: { id: string; snap: StateSnapshot; embedded?: boolean }) {
  const { detail, missing, reload } = useTeamDetail(id);
  const now = useBox(clock);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const closeDiff = useCallback(() => setDiffPath(null), []);
  // 스냅샷의 팀이 더 자주 갱신되므로 머리 부분은 스냅샷을 우선한다.
  const tm = snap.teams.find((x) => x.id === id) ?? detail?.team ?? null;
  const remote = snap.access === 'remote';

  // 화면에 보이는 동안 이 팀의 답을 읽음으로(훅은 이른 반환보다 앞에)
  const msgList = detail?.messages ?? [];
  const lastId = msgList.length ? msgList[msgList.length - 1]!.id : 0;
  const unreadNow = tm?.unread ?? 0;
  useEffect(() => {
    if (embedded || !lastId || !unreadNow) return;
    const mark = () => { if (document.visibilityState === 'visible') void api('/api/seen', 'POST', { team_id: id, up_to: lastId }).then(() => refreshState()).catch(() => {}); };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [lastId, id, unreadNow, embedded]);

  if (!tm) return (
    <div className="stack">
      <div><button className="back" type="button" onClick={() => go('home')}>{t('← 업무 목록')}</button></div>
      <div className="panel muted">{missing ? t('팀을 찾을 수 없습니다.') : t('불러오는 중…')}</div>
    </div>
  );

  const standing = tm.lifetime === 'standing';
  const call = (path: string, body?: unknown, ok?: string) => act(async () => { const r = await api<unknown>(`/api/teams/${encodeURIComponent(tm.id)}/${path}`, 'POST', body ?? {}); await refreshState(); reload(); return r; }, ok);
  const finished = tm.state === 'done' || tm.state === 'failed' || tm.state === 'archived';
  const canCompose = !finished && tm.state !== 'waiting_human';

  const answer = async (text: string) => (await call('answer', { text }, t('답을 보냈습니다'))) !== undefined;
  const message = async (text: string) => {
    const r = await act(() => api<{ result: 'delivered' | 'queued' }>(`/api/teams/${encodeURIComponent(tm.id)}/message`, 'POST', { text }));
    if (!r) return false;
    toast(r.result === 'delivered' ? t('지시를 전달했습니다') : t('지시를 받아 두었습니다 · 팀이 돌면 반영'), 'good');
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
      {!embedded && <div><button className="back" type="button" onClick={() => go('home')}>{t('← 업무 목록')}</button></div>}
      <div className="team-head">
        <div className="row">
          <span className={`lamp ${lampState(tm.state)}`} />
          <span className={`tag ${tm.state}`}>{standing && tm.state === 'idle' ? t('상시 대기') : STATE_LABEL[tm.state]}</span>
          {tm.priority !== 'normal' && <span className={`chip ${tm.priority}`}>{PRI[tm.priority]}</span>}
          <span className="chip">{standing ? t('직속 팀') : t('업무 팀')}</span>
          {tm.pinned && <span className="chip">{t('멈추지 않음')}</span>}
          {tm.project_name && <span className="chip">{tm.project_name}</span>}
        </div>
        <h1>{tm.title || tm.name}</h1>
        {!standing && <Steps stage={tm.stage} />}
        <div className="row meta-row">
          {tm.branch && <span className="mono muted">{tm.branch}</span>}
          <span className="muted">{money(tm.cost_usd)}{tm.budget_usd != null ? t(' / 상한 {amount}', { amount: money(tm.budget_usd) }) : ''}</span>
          <span className="muted">{t('· 만듦 {time}', { time: hhmm(tm.created_at) })}{tm.started_at ? t(' · 시작 {time} · {elapsed}', { time: hhmm(tm.started_at), elapsed: elapsed(tm, now) }) : ''}{tm.finished_at ? t(' · 끝 {time}', { time: hhmm(tm.finished_at) }) : ''}</span>
        </div>
        {(tm.state === 'paused' || tm.state === 'queued') && tm.paused_reason && <div className="task-note warn">{tm.state === 'paused' && tm.pause_kind?.startsWith('engine') ? t('총괄 엔진이 멈춤 · 리소스가 회복되면 자동으로 재개합니다 · {reason}', { reason: tm.paused_reason }) : tm.paused_reason}</div>}
        {tm.resume_grace_until && tm.state === 'running' && <div className="task-note">{t('직접 재개함 · {time}까지 자동 멈춤 안 함', { time: hhmm(tm.resume_grace_until) })}</div>}
        {tm.state === 'failed' && <div className="task-note crit">{t('실패: {error}', { error: tm.error ?? t('이유 없음') })}</div>}
        {tm.error && tm.state !== 'failed' && <div className="task-note warn">{tm.error}</div>}
        {!embedded && tm.state === 'waiting_human' && (
          <div className="ask-box">
            <div className="q-h">{t('PM의 질문')}{tm.question ? ` · ${hhmm(tm.question.asked_at)}` : ''}{t(' · 답하면 팀이 바로 다시 가동')}</div>
            <p>{tm.question?.text ?? tm.paused_reason ?? t('사람 확인이 필요합니다')}</p>
            {!!tm.question?.options.length && <div className="row">{tm.question.options.map((o) => <button key={o} className="btn" type="button" onClick={() => void answer(o)}>{o}</button>)}</div>}
            <Composer placeholder={t('직접 답하기')} label={t('PM 질문에 직접 답하기')} button={t('답하기')} onSend={answer} />
          </div>
        )}
        {!embedded && canCompose && (
          <div>
            <div className="composer-h">{standing ? t('총괄을 거치지 않고 이 팀에 바로 지시합니다') : t('이 팀 PM에게 직접 지시합니다 · 총괄도 기록을 함께 봅니다')}{tm.state === 'paused' || tm.state === 'queued' ? t(' · 지금은 멈춰 있어 재개될 때 반영') : ''}</div>
            <Composer placeholder={standing ? t('예: 지금 api 서버 에러율 확인해줘') : t('PM에게 직접 지시')} label={t('팀에 직접 지시')} button={t('지시@단추')} onSend={message} working={tm.state === 'running'} onCancel={() => call('interrupt', {}, t('진행 중이던 지시를 취소했습니다'))} />
          </div>
        )}
        {!embedded && <QaBox msgs={msgs} working={tm.state === 'running'} />}
        <div className="row">
          {tm.state === 'running' && !standing && <button className="btn" type="button" onClick={() => void call('pause', {}, t('멈춤 요청을 보냈습니다'))}>{t('멈춤')}</button>}
          {tm.state === 'paused' && <button className="btn primary" type="button" title={t('15분 동안 엔진이 자동으로 멈추지 않습니다')} onClick={() => void call('resume', {}, t('재개했습니다 · 15분 동안 자동 멈춤 안 함'))}>{tm.pause_kind?.startsWith('engine') ? t('지금 재개 (15분 보호)') : t('재개')}</button>}
          {!standing && !finished && <button className="btn" type="button" aria-pressed={tm.pinned} onClick={() => void call('pin', { on: !tm.pinned })}>{tm.pinned ? t('멈추지 않음 해제') : t('멈추지 않음')}</button>}
          {!standing && !finished && (
            <label className="inline-sel">{t('우선순위')}
              <select value={tm.priority} onChange={(e) => void call('priority', { priority: e.target.value as Priority })}>
                <option value="urgent">{t('긴급')}</option><option value="normal">{t('보통')}</option><option value="low">{t('낮음')}</option>
              </select>
            </label>
          )}
          {tm.state === 'failed' && <button className="btn primary" type="button" onClick={() => void call('retry', {}, t('대기열에 다시 넣었습니다'))}>{t('다시 시작')}</button>}
          {/* 일하는 업무 팀만 「중단」, 직속 팀은 「직속 팀 종료」. 끝났거나 멈춘·대기·확인 대기 업무 팀은 아래 「팀 정리」 하나로 */}
          {standing ? <ConfirmButton label={t('직속 팀 종료')} confirmLabel={t('이 직속 팀을 종료할까요? 다시 쓰려면 새로 만들어야 합니다.')} onConfirm={() => void call('cancel', {}, t('직속 팀을 종료했습니다'))} />
            : tm.state === 'running' && <ConfirmButton label={t('중단')} confirmLabel={t('이 팀을 중단할까요? 진행 중인 턴이 끊깁니다.')} onConfirm={() => void call('cancel', {}, t('중단했습니다'))} />}
          {/* 「다시 시작」과 떨어뜨려 오른쪽 끝에. 대화 종료 · 작업 폴더 패치 보관 후 삭제 · 목록에서 빼기를 한 번에 */}
          {!standing && CLOSABLE.includes(tm.state) && !remote && (
            <span className="team-close">
              <ConfirmButton className="btn ghost" label={t('팀 정리')}
                confirmLabel={tm.worktree_path ? t('팀을 정리할까요? 대화를 끝내고, 작업 폴더는 변경을 패치로 남긴 뒤 지우고(브랜치는 남김), 업무 팀 목록에서 빼 끝난 팀으로 옮깁니다.') : t('팀을 정리할까요? 대화를 끝내고 업무 팀 목록에서 빼 끝난 팀으로 옮깁니다.')}
                onConfirm={() => void call('close', {}, t('팀을 정리했습니다 · 끝난 팀으로 옮김'))} />
            </span>
          )}
        </div>
      </div>

      {snap.prs.some((p) => p.team_id === tm.id) && (
        <div className="panel"><h3>{t('이 팀이 만든 PR')}</h3>
          <div className="pr-list">{snap.prs.filter((p) => p.team_id === tm.id).map((p) => <PrRow key={p.url} pr={p} snap={snap} />)}</div>
        </div>
      )}

      <div className="panel env-box">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}><b>{t('작업 환경')}</b> <small className="muted">{tm.env_mode === 'mine' ? t('내 Claude Code 와 동일: 내 설정·플러그인·스킬·MCP 도구, 메모리 쓰기 · 운영 DB·배포·인프라 명령은 승인 뒤 실행') : t('격리: 저장소 규칙(CLAUDE.md·AGENTS.md)만 · 운영 명령은 막힘')}</small></div>
          <select value={tm.env_mode} disabled={remote || tm.state === 'running'} title={tm.state === 'running' ? t('일하는 중에는 못 바꿈') : remote ? t('맥에서만 바꿀 수 있음') : ''} onChange={(e) => void act(async () => { await api(`/api/teams/${encodeURIComponent(tm.id)}/env`, 'PATCH', { env_mode: e.target.value }); await refreshState(); }, t('작업 환경을 바꿨습니다 · 다음 지시부터 적용'))}>
            <option value="isolated">{t('격리 (기본)')}</option><option value="mine">{t('내 Claude Code 와 동일')}</option>
          </select>
        </div>
      </div>

      {standing && (
        <div className="panel standing-info">
          <h3>{t('상시 지시서')}</h3>
          <div className="brief">{tm.standing_brief ? <RichText text={tm.standing_brief} /> : <span className="muted">{t('비어 있음 (설정 › 직속 팀에서 수정)')}</span>}</div>
          <div className="kv">
            <div><small>{t('점검 명령')}</small><b>{tm.check_command ?? t('없음')}</b></div>
            <div><small>{t('점검 주기')}</small><b>{tm.check_interval_sec ? t('{n}초', { n: tm.check_interval_sec }) : '—'}</b></div>
            <div><small>{t('마지막 점검')}</small><b className={tm.last_check_ok === false ? 'crit-t' : tm.last_check_ok ? 'good-t' : ''}>{tm.last_check_at ? `${hhmm(tm.last_check_at)} · ${tm.last_check_ok ? t('이상 없음') : t('이상')}` : '—'}</b></div>
            <div><small>{t('되살림')}</small><b>{t('{n}회', { n: tm.revived_count })}</b></div>
            <div><small>{t('생존 확인')}</small><b>{agoSec(tm.last_heartbeat_at, now)}</b></div>
          </div>
        </div>
      )}

      <Agents tm={tm} />

      <div className="team-grid">
        <div className="stack">
          {!embedded && <div className="panel"><h3>{t('팀 대화')} <small className="muted">{t('최신이 위')}</small></h3>
            <div className="timeline">
              {msgs.length ? [...msgs].reverse().map((m) => (
                <div key={m.id} className="msg"><time className="mono">{hhmm(m.created_at)}</time>
                  <div className={`bubble ${m.kind}`}>
                    <div className="who"><span className={`k ${m.kind}`}>{KIND_LABEL[m.kind] ?? m.kind}</span><b>{whoLabel(m.from_label)}</b>{m.to_label && <span className="muted">→ {whoLabel(m.to_label)}</span>}</div>
                    <div className="msg-body"><RichText text={m.body} /></div>
                  </div>
                </div>
              )) : <div className="muted">{detail ? t('아직 대화가 없습니다.') : t('불러오는 중…')}</div>}
            </div>
          </div>}
          {sums.length > 0 && (
            <div className="panel"><h3>{t('요약')}</h3>
              <div className="timeline">{sums.map((s, i) => <div key={i} className="msg"><time className="mono">{hhmm(s.created_at)}</time><div className="bubble report"><div className="who"><span className="k report">{t(s.stage)}</span></div><div className="msg-body"><RichText text={s.body} /></div></div></div>)}</div>
            </div>
          )}
        </div>
        <div className="stack">
          {!standing && (
            <>
              <div className="panel"><h3>{t('할 일 · 완료 기준')}</h3>
                <ul className="check">{check.length ? check.map((c) => <li key={c.idx} className={c.done ? 'ok' : ''}><span className="bx">{c.done ? '✓' : ''}</span><span>{c.text}</span></li>) : <li className="muted">{t('아직 없음')}</li>}</ul>
              </div>
              <div className="panel"><h3>{t('바뀐 파일')}</h3>
                <ul className="files">{files.length ? files.map((f) => (
                  <li key={f.path}><button type="button" className="file-btn" title={f.path} onClick={() => setDiffPath(f.path)}><span className="p mono">{f.change_type === 'added' ? '＋ ' : f.change_type === 'deleted' ? '－ ' : ''}{f.path.split('/').slice(-2).join('/')}</span></button><span className="mono"><span className="add">+{f.lines_added}</span> <span className="del">−{f.lines_removed}</span></span></li>
                )) : <li className="muted">{t('아직 없음')}</li>}</ul>
              </div>
            </>
          )}
          <div className="panel"><h3>{t('총괄 결정 기록')}</h3>
            <ul className="decisions">{decs.length ? decs.map((d) => <li key={d.id}><span className="mono muted">{hhmm(d.created_at)}</span><span><b>{ACTOR[d.actor] ?? d.actor}</b> · {d.reason || d.action}</span></li>) : <li className="muted">{t('없음')}</li>}</ul>
          </div>
        </div>
      </div>
      {diffPath && <DiffModal teamId={tm.id} path={diffPath} onClose={closeDiff} />}
    </>
  );
}
