import { useEffect, useRef } from 'react';
import type { StateSnapshot, TeamDetail, TeamView } from '../../shared/types.ts';
import { ChatInput } from './ChatInput.tsx';
import { DOT_LABEL, dotOf, sideNote } from './chan.ts';
import { act, api, clock, go, refreshState, toast, useBox } from './store.ts';
import { Team, useTeamDetail } from './Team.tsx';
import { RichText, hhmm, money } from './ui.tsx';

type Msg = TeamDetail['messages'][number];

/** 팀원끼리 주고받은 긴 글은 접어서 한 줄로 */
function Fold({ m }: { m: Msg }) {
  const head = m.body.replace(/\s+/g, ' ').slice(0, 90);
  return (
    <details className="tc-fold">
      <summary><span className="mono muted">{hhmm(m.created_at)}</span> <b>{m.from_label}</b> → {m.to_label} · {m.kind === 'handoff' ? '맡김' : '보고'}: <span className="muted">{head}{m.body.length > 90 ? '…' : ''}</span></summary>
      <div className="tc-fold-b"><RichText text={m.body} /></div>
    </details>
  );
}

function Line({ m }: { m: Msg }) {
  if (m.from_label === '사용자') return (
    <div className="tc-me"><div className="tc-bub me"><RichText text={m.body} /></div><span className="tc-t">{hhmm(m.created_at)}</span></div>
  );
  if (m.from_label === 'PO 엔진') return <div className="tc-sys"><span className="mono">{hhmm(m.created_at)}</span> {m.body.split('\n')[0]}</div>;
  if (m.from_label === 'PM' && (m.kind === 'report' || m.kind === 'question')) return (
    <div className="tc-them">
      <span className="tc-av" aria-hidden="true">PM</span>
      <div className="tc-col">
        <div className="tc-who"><b>PM</b> {m.kind === 'question' ? '질문' : m.to_label === '사용자' ? '답변' : 'PO 에게 보고'} · <span className="mono">{hhmm(m.created_at)}</span></div>
        <div className={`tc-bub${m.kind === 'question' ? ' q' : ''}`}><RichText text={m.body} /></div>
      </div>
    </div>
  );
  if (m.from_label === 'PO') return (
    <div className="tc-them">
      <span className="tc-av po" aria-hidden="true">PO</span>
      <div className="tc-col">
        <div className="tc-who"><b>PO</b> 지시 · <span className="mono">{hhmm(m.created_at)}</span></div>
        <div className="tc-bub po"><RichText text={m.body} /></div>
      </div>
    </div>
  );
  return <Fold m={m} />;
}

function Head({ t, snap, detail }: { t: TeamView; snap: StateSnapshot; detail: boolean }) {
  const now = useBox(clock);
  const dot = dotOf(t);
  const note = sideNote(t, now);
  const prs = snap.prs.filter((p) => p.team_id === t.id && p.state === 'OPEN');
  const call = (path: string, ok: string) => act(async () => { await api(`/api/teams/${encodeURIComponent(t.id)}/${path}`, 'POST', {}); await refreshState(); }, ok);
  return (
    <header className="tc-h">
      <button type="button" className="tc-back" onClick={() => go('list')} aria-label="채널 목록">←</button>
      <span className={`sdot ${dot}`} aria-label={DOT_LABEL[dot]} />
      <div className="tc-title">
        <h1>{t.title || t.name}</h1>
        <div className="tc-sub">
          {t.lifetime === 'standing' ? '직속 팀' : '업무 팀'}{t.project_name ? ` · ${t.project_name}` : ''} · {note?.text ?? DOT_LABEL[dot]}
          {t.env_mode === 'mine' && <span className="tc-chip">내 환경</span>}
          {t.busy_note && t.state === 'running' && <span className="muted"> · {t.busy_note}</span>}
          <span className="muted"> · {money(t.cost_usd)}</span>
        </div>
      </div>
      <div className="tc-acts">
        {prs.map((p) => <a key={p.url} className="tc-pr" href={p.url} target="_blank" rel="noreferrer">PR #{p.number} ↗</a>)}
        {t.state === 'running' && t.lifetime === 'task' && <button className="btn" type="button" onClick={() => void call('pause', '멈춤 요청을 보냈습니다')}>멈춤</button>}
        {t.state === 'paused' && <button className="btn primary" type="button" onClick={() => void call('resume', '재개했습니다 · 15분 동안 자동 멈춤 안 함')}>재개</button>}
        {t.state === 'failed' && <button className="btn primary" type="button" onClick={() => void call('retry', '대기열에 다시 넣었습니다')}>다시 시작</button>}
        <a className={`btn${detail ? ' on' : ''}`} href={detail ? `#team-${t.id}` : `#team-${t.id}/detail`} aria-pressed={detail}>팀 상세</a>
      </div>
    </header>
  );
}

export function TeamChannel({ id, snap, detail }: { id: string; snap: StateSnapshot; detail: boolean }) {
  const { detail: d, missing, reload } = useTeamDetail(id);
  const t = snap.teams.find((x) => x.id === id) ?? d?.team ?? null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const msgs = d?.messages ?? [];
  const lastId = msgs.length ? msgs[msgs.length - 1]!.id : 0;

  // 새 글이 오면 아래로(사용자가 위로 올려 읽는 중이면 그대로)
  useEffect(() => { const el = bodyRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lastId, t?.state]);
  // 보이는 동안 읽음으로
  const unread = t?.unread ?? 0;
  useEffect(() => {
    if (!lastId || !unread) return;
    const mark = () => { if (document.visibilityState === 'visible') void api('/api/seen', 'POST', { team_id: id, up_to: lastId }).then(() => refreshState()).catch(() => {}); };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [lastId, id, unread]);

  if (!t) return <div className="tc"><div className="tc-empty">{missing ? '팀을 찾을 수 없습니다.' : '불러오는 중…'}</div></div>;

  const finished = ['done', 'archived'].includes(t.state);
  // 직속 팀은 질문을 걸어 두고도 상태가 「대기」라 상태 대신 질문 유무로 본다
  const asking = !!t.question && ['waiting_human', 'idle', 'down', 'paused'].includes(t.state);
  const approval = !!asking && t.question!.options.includes('승인') && t.question!.options.includes('거절');
  const send = async (text: string) => {
    if (asking) { const r = await act(() => api(`/api/teams/${encodeURIComponent(t.id)}/answer`, 'POST', { text })); if (r === undefined) return false; await refreshState(); reload(); return true; }
    const r = await act(() => api<{ result: 'delivered' | 'queued' }>(`/api/teams/${encodeURIComponent(t.id)}/message`, 'POST', { text }));
    if (!r) return false;
    if (r.result === 'queued') toast('받아 두었습니다 · 팀이 다시 돌면 반영', 'info');
    stick.current = true;
    reload();
    return true;
  };

  return (
    <div className={`tc${detail ? ' with-detail' : ''}`}>
      <section className="tc-main">
        <Head t={t} snap={snap} detail={detail} />
        <div className="tc-body" ref={bodyRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {t.lifetime === 'standing' && msgs.length === 0 && <div className="tc-sys">상시 지시서에 따라 대기 중입니다. 아래에 바로 지시하세요.</div>}
          {msgs.map((m) => <Line key={m.id} m={m} />)}
          {t.state === 'running' && <div className="tc-typing"><span className="typing"><span /><span /><span /></span> {t.busy_note ?? 'PM 일하는 중'}</div>}
          {t.state === 'paused' && <div className="tc-sys warn">멈춤 · {t.paused_reason ?? ''}</div>}
          {t.state === 'failed' && <div className="tc-sys crit">실패 · {t.error ?? '이유 없음'}</div>}
        </div>
        {asking && (
          <div className={`tc-ask${approval ? ' approval' : ''}`}>
            <div className="tc-ask-h">{approval ? '명령 승인 요청' : 'PM 질문'} · {hhmm(t.question!.asked_at)} · 답하면 바로 다시 일합니다</div>
            <div className="tc-ask-q"><RichText text={t.question!.text} /></div>
            {t.question!.options.length > 0 && (
              <div className="tc-ask-o">{t.question!.options.map((o, i) => <button key={o} type="button" className={`btn${i === 0 ? ' primary' : ''}`} onClick={() => void send(o)}>{o}</button>)}</div>
            )}
          </div>
        )}
        {!finished ? (
          <div className="tc-in">
            <ChatInput
              placeholder={asking ? '직접 답하기' : t.lifetime === 'standing' ? `${t.name}에 바로 지시` : 'PM에게 직접 지시'}
              label={asking ? 'PM 질문에 답하기' : '팀에 지시'}
              button={asking ? '답하기' : '보내기'}
              onSend={send}
              working={t.state === 'running'}
              onCancel={() => act(async () => { await api(`/api/teams/${encodeURIComponent(t.id)}/interrupt`, 'POST', {}); await refreshState(); }, '진행 중이던 지시를 취소했습니다')}
              cancelLabel="진행 취소"
            />
          </div>
        ) : <div className="tc-in muted">끝난 팀입니다. 이어서 하려면 PO에게 새 업무로 맡기세요.</div>}
      </section>
      {detail && (
        <aside className="tc-detail" aria-label="팀 상세">
          <div className="tc-detail-h"><b>팀 상세</b><a className="btn" href={`#team-${t.id}`}>닫기</a></div>
          <div className="tc-detail-b"><Team id={t.id} snap={snap} embedded /></div>
        </aside>
      )}
    </div>
  );
}
