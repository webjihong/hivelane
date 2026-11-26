import { useEffect, useRef } from 'react';
import { NewBelow, useStickToBottom } from './stick.tsx';
import type { StateSnapshot, TeamDetail, TeamView } from '../../shared/types.ts';
import { ChatInput } from './ChatInput.tsx';
import { DOT_LABEL, dotOf, isApproval, sideNote } from './chan.ts';
import { act, api, clock, go, refreshState, toast, useBox } from './store.ts';
import { Team, useTeamDetail } from './Team.tsx';
import { WorktreeCleanButton } from './GitClean.tsx';
import { t, tn } from './i18n.ts';
import { RichText, hhmm, money, whoLabel } from './ui.tsx';

type Msg = TeamDetail['messages'][number];

/** 팀원끼리 주고받은 긴 글은 접어서 한 줄로 */
function Fold({ m }: { m: Msg }) {
  const head = m.body.replace(/\s+/g, ' ').slice(0, 90);
  return (
    <details className="tc-fold">
      <summary><span className="mono muted">{hhmm(m.created_at)}</span> <b>{whoLabel(m.from_label)}</b> → {whoLabel(m.to_label)} · {m.kind === 'handoff' ? t('맡김') : t('보고')}: <span className="muted">{head}{m.body.length > 90 ? '…' : ''}</span></summary>
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
        <div className="tc-who"><b>PM</b> {m.kind === 'question' ? t('질문') : m.to_label === '사용자' ? t('답변') : t('총괄에게 보고')} · <span className="mono">{hhmm(m.created_at)}</span></div>
        <div className={`tc-bub${m.kind === 'question' ? ' q' : ''}`}><RichText text={m.body} /></div>
      </div>
    </div>
  );
  if (m.from_label === 'PO') return (
    <div className="tc-them">
      <span className="tc-av po" aria-hidden="true">{t('총괄')}</span>
      <div className="tc-col">
        <div className="tc-who">{tn('{who} 지시', { who: <b>{t('총괄')}</b> })} · <span className="mono">{hhmm(m.created_at)}</span></div>
        <div className="tc-bub po"><RichText text={m.body} /></div>
      </div>
    </div>
  );
  return <Fold m={m} />;
}

function Head({ tm, snap, detail }: { tm: TeamView; snap: StateSnapshot; detail: boolean }) {
  const now = useBox(clock);
  const dot = dotOf(tm);
  const note = sideNote(tm, now);
  const prs = snap.prs.filter((p) => p.team_id === tm.id && p.state === 'OPEN');
  const call = (path: string, ok: string) => act(async () => { await api(`/api/teams/${encodeURIComponent(tm.id)}/${path}`, 'POST', {}); await refreshState(); }, ok);
  return (
    <header className="tc-h">
      <button type="button" className="tc-back" onClick={() => go('list')} aria-label={t('채널 목록')}>←</button>
      <span className={`sdot ${dot}`} aria-label={DOT_LABEL[dot]} />
      <div className="tc-title">
        <h1>{tm.title || tm.name}</h1>
        <div className="tc-sub">
          {tm.lifetime === 'standing' ? t('직속 팀') : t('업무 팀')}{tm.project_name ? ` · ${tm.project_name}` : ''} · {note?.text ?? DOT_LABEL[dot]}
          {tm.env_mode === 'mine' && <span className="tc-chip">{t('내 환경')}</span>}
          {tm.busy_note && tm.state === 'running' && <span className="muted"> · {tm.busy_note}</span>}
          <span className="muted"> · {money(tm.cost_usd)}</span>
        </div>
      </div>
      <div className="tc-acts">
        {prs.map((p) => <a key={p.url} className="tc-pr" href={`#prs/${p.project_id}:${p.number}`} title={p.title}>PR #{p.number}</a>)}
        {tm.state === 'running' && tm.lifetime === 'task' && <button className="btn" type="button" onClick={() => void call('pause', t('멈춤 요청을 보냈습니다'))}>{t('멈춤')}</button>}
        {tm.state === 'paused' && <button className="btn primary" type="button" onClick={() => void call('resume', t('재개했습니다 · 15분 동안 자동 멈춤 안 함'))}>{t('재개')}</button>}
        {tm.state === 'failed' && <button className="btn primary" type="button" onClick={() => void call('retry', t('대기열에 다시 넣었습니다'))}>{t('다시 시작')}</button>}
        {tm.lifetime === 'task' && (tm.state === 'done' || tm.state === 'failed') && tm.worktree_path && snap.access === 'local' && <WorktreeCleanButton teamId={tm.id} />}
        <a className={`btn${detail ? ' on' : ''}`} href={detail ? `#team-${tm.id}` : `#team-${tm.id}/detail`} aria-pressed={detail}>{t('팀 상세')}</a>
      </div>
    </header>
  );
}

export function TeamChannel({ id, snap, detail }: { id: string; snap: StateSnapshot; detail: boolean }) {
  const { detail: d, missing, reload } = useTeamDetail(id);
  const tm = snap.teams.find((x) => x.id === id) ?? d?.team ?? null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const sb = useStickToBottom(bodyRef, !!tm);
  const msgs = d?.messages ?? [];
  const lastId = msgs.length ? msgs[msgs.length - 1]!.id : 0;

  // 보이는 동안 읽음으로
  const unread = tm?.unread ?? 0;
  useEffect(() => {
    if (!lastId || !unread) return;
    const mark = () => { if (document.visibilityState === 'visible') void api('/api/seen', 'POST', { team_id: id, up_to: lastId }).then(() => refreshState()).catch(() => {}); };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [lastId, id, unread]);

  if (!tm) return <div className="tc"><div className="tc-empty">{missing ? t('팀을 찾을 수 없습니다.') : t('불러오는 중…')}</div></div>;

  const finished = ['done', 'archived'].includes(tm.state);
  // 직속 팀은 질문을 걸어 두고도 상태가 「대기」라 상태 대신 질문 유무로 본다
  const asking = !!tm.question && ['waiting_human', 'idle', 'down', 'paused'].includes(tm.state);
  const approval = !!asking && isApproval(tm.question!.options);
  const send = async (text: string) => {
    if (asking) { const r = await act(() => api(`/api/teams/${encodeURIComponent(tm.id)}/answer`, 'POST', { text })); if (r === undefined) return false; await refreshState(); reload(); return true; }
    const r = await act(() => api<{ result: 'delivered' | 'queued' }>(`/api/teams/${encodeURIComponent(tm.id)}/message`, 'POST', { text }));
    if (!r) return false;
    if (r.result === 'queued') toast(t('받아 두었습니다 · 팀이 다시 돌면 반영'), 'info');
    sb.stickNow();
    reload();
    return true;
  };

  return (
    <div className={`tc${detail ? ' with-detail' : ''}`}>
      <section className="tc-main">
        <Head tm={tm} snap={snap} detail={detail} />
        <div className="tc-scroll">
        <div className="tc-body" ref={bodyRef} onScroll={sb.onScroll}>
          {tm.lifetime === 'standing' && msgs.length === 0 && <div className="tc-sys">{t('상시 지시서에 따라 대기 중입니다. 아래에 바로 지시하세요.')}</div>}
          {msgs.map((m) => <Line key={m.id} m={m} />)}
          {tm.state === 'running' && <div className="tc-typing"><span className="typing"><span /><span /><span /></span> {tm.busy_note ?? t('PM 일하는 중')}</div>}
          {tm.state === 'paused' && <div className="tc-sys warn">{t('멈춤 · {reason}', { reason: tm.paused_reason ?? '' })}</div>}
          {tm.state === 'failed' && <div className="tc-sys crit">{t('실패')} · {tm.error ?? t('이유 없음')}</div>}
        </div>
        <NewBelow show={sb.newBelow} onClick={sb.jump} />
        </div>
        {asking && (
          <div className={`tc-ask${approval ? ' approval' : ''}`}>
            <div className="tc-ask-h">{approval ? t('명령 승인 요청') : t('PM 질문')} · {hhmm(tm.question!.asked_at)} · {t('답하면 바로 다시 일합니다')}</div>
            <div className="tc-ask-q"><RichText text={tm.question!.text} /></div>
            {tm.question!.options.length > 0 && (
              <div className="tc-ask-o">{tm.question!.options.map((o, i) => <button key={o} type="button" className={`btn${i === 0 ? ' primary' : ''}`} onClick={() => void send(o)}>{o}</button>)}</div>
            )}
          </div>
        )}
        {!finished ? (
          <div className="tc-in">
            <ChatInput
              placeholder={asking ? t('직접 답하기') : tm.lifetime === 'standing' ? t('{name}에 바로 지시', { name: tm.name }) : t('PM에게 직접 지시')}
              label={asking ? t('PM 질문에 답하기') : t('팀에 지시')}
              button={asking ? t('답하기') : t('보내기')}
              onSend={send}
              working={tm.state === 'running'}
              onCancel={() => act(async () => { await api(`/api/teams/${encodeURIComponent(tm.id)}/interrupt`, 'POST', {}); await refreshState(); }, t('진행 중이던 지시를 취소했습니다'))}
              cancelLabel={t('진행 취소')}
              draftKey={`team:${tm.id}`}
            />
          </div>
        ) : <div className="tc-in muted">{t('끝난 팀입니다. 이어서 하려면 총괄에게 새 업무로 맡기세요.')}</div>}
      </section>
      {detail && (
        <aside className="tc-detail" aria-label={t('팀 상세')}>
          <div className="tc-detail-h"><b>{t('팀 상세')}</b><a className="btn" href={`#team-${tm.id}`}>{t('닫기')}</a></div>
          <div className="tc-detail-b"><Team id={tm.id} snap={snap} embedded /></div>
        </aside>
      )}
    </div>
  );
}
