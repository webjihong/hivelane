import type { StateSnapshot, TeamView } from '../../shared/types.ts';
import { asks, dotOf, nowCount } from './chan.ts';
import { PrRow } from './Prs.tsx';
import { act, api, chat, clock, go, refreshState, useBox } from './store.ts';

const STAGE = ['기획', '구현', '검사', '보고'];

function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}
/** 미리보기 한 줄: 마크다운 기호 걷고 첫 문장 */
function preview(s: string): string {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '[이미지]').replace(/[*`#>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function Need({ t, snap }: { t: TeamView; snap: StateSnapshot }) {
  const now = useBox(clock);
  const answer = (text: string) => act(async () => { await api(`/api/teams/${encodeURIComponent(t.id)}/answer`, 'POST', { text }); await refreshState(); }, '답을 보냈습니다');
  const approval = t.question?.options.includes('승인') && t.question.options.includes('거절');
  if (t.state === 'failed') return (
    <article className="nw-card crit">
      <div className="nw-meta"><b>{t.title || t.name}</b> · 실패 · {ago(t.finished_at, now)}</div>
      <div className="nw-q">{t.error ?? '이유 없음'}</div>
      <div className="nw-acts"><button className="btn primary" type="button" onClick={() => void act(async () => { await api(`/api/teams/${t.id}/retry`, 'POST', {}); await refreshState(); }, '대기열에 다시 넣었습니다')}>다시 시작</button><a className="btn" href={`#team-${t.id}`}>채널 열기</a></div>
    </article>
  );
  if (t.state === 'down' && !t.question) return (
    <article className="nw-card crit">
      <div className="nw-meta"><b>{t.name}</b> · 직속 팀 장애 · 자동으로 다시 살리는 중</div>
      <div className="nw-q">{t.error ?? '원인 확인 중'}</div>
      <div className="nw-acts"><a className="btn" href={`#team-${t.id}`}>채널 열기</a></div>
    </article>
  );
  return (
    <article className="nw-card ask">
      <div className="nw-meta"><b>{t.title || t.name}</b> · {approval ? '명령 승인 요청' : 'PM 질문'} · {ago(t.question?.asked_at, now)}</div>
      <div className="nw-q clamp3">{t.question?.text ?? t.paused_reason ?? '사람 확인이 필요합니다'}</div>
      <div className="nw-acts">
        {(t.question?.options ?? []).map((o, i) => <button key={o} className={`btn${i === 0 ? ' primary' : ''}`} type="button" onClick={() => void answer(o)}>{o}</button>)}
        <a className="btn ghost" href={`#team-${t.id}`}>채널에서 답하기</a>
      </div>
    </article>
  );
}

export function Now({ snap }: { snap: StateSnapshot }) {
  const now = useBox(clock);
  const rows = useBox(chat);
  const live = snap.teams.filter((t) => t.state !== 'archived');
  const needs = live.filter((t) => asks(t) || t.state === 'waiting_human' || t.state === 'failed' || t.state === 'down');
  const proposals = snap.proposals.filter((p) => p.status === 'pending');
  const unread = live.filter((t) => t.unread > 0 && !asks(t) && t.state !== 'waiting_human');
  const lastPo = snap.poUnread ? [...rows].reverse().find((c) => c.role === 'po') : undefined;
  const freshPrs = snap.prs.filter((p) => p.state === 'OPEN' && now - Date.parse(p.updated_at) < 86_400_000);
  const working = live.filter((t) => ['running', 'paused', 'queued', 'reviving'].includes(t.state));
  const openPrs = snap.prs.filter((p) => p.state === 'OPEN');
  const { need, news } = nowCount(snap);

  const allRead = () => act(async () => {
    await Promise.all([...unread.map((t) => api('/api/seen', 'POST', { team_id: t.id })), ...(snap.poUnread ? [api('/api/seen', 'POST', { po: true })] : [])]);
    await refreshState();
  }, '모두 읽음으로 표시했습니다');

  return (
    <div className="nw">
      <header className="nw-h">
        <h1>지금 볼 것</h1>
        <span className="muted">{need ? `답·결정이 필요한 것 ${need}` : '답할 것 없음'} · 새 소식 {news}</span>
        {news > 0 && <button type="button" className="link-btn" onClick={() => void allRead()}>모두 읽음으로</button>}
      </header>

      <div className="nw-tiles">
        <button type="button" className={`nw-tile${need ? ' ask' : ''}`} onClick={() => document.getElementById('nw-need')?.scrollIntoView({ behavior: 'smooth' })}><b>{need}</b><span>결정 기다림</span></button>
        <button type="button" className="nw-tile run" onClick={() => document.getElementById('nw-work')?.scrollIntoView({ behavior: 'smooth' })}><b>{working.filter((t) => t.state === 'running').length}</b><span>일하는 팀</span></button>
        <button type="button" className="nw-tile pr" onClick={() => go('prs')}><b>{openPrs.length}</b><span>열린 PR</span></button>
        <button type="button" className="nw-tile" onClick={() => document.getElementById('nw-news')?.scrollIntoView({ behavior: 'smooth' })}><b>{news}</b><span>새 소식</span></button>
      </div>

      <section id="nw-need" className="nw-sec">
        <h2 className="ask-t">내 답이 필요함</h2>
        {needs.length || proposals.length ? (
          <div className="nw-list">
            {needs.map((t) => <Need key={t.id} t={t} snap={snap} />)}
            {proposals.map((p) => (
              <article key={p.id} className="nw-card ask">
                <div className="nw-meta"><b>PO 팀 구성 제안</b> · {p.project_name ?? '프로젝트 없음'}</div>
                <div className="nw-q">{p.title}</div>
                <div className="nw-acts"><a className="btn primary" href="#po">PO에서 승인·수정</a></div>
              </article>
            ))}
          </div>
        ) : <div className="nw-empty">지금 답할 것은 없습니다.</div>}
      </section>

      <section id="nw-news" className="nw-sec">
        <h2 className="news-t">새 소식</h2>
        {unread.length || lastPo || freshPrs.length ? (
          <div className="nw-rows">
            {unread.map((t) => (
              <a key={t.id} href={`#team-${t.id}`} className="nw-row">
                <span className="nw-kind news">새 답변</span>
                <span className="nw-text"><b>{t.title || t.name}</b>{t.unread > 1 ? ` (${t.unread})` : ''} · {preview(t.last_msg?.body ?? '')}</span>
                <span className="nw-when">{ago(t.last_msg?.at, now)}</span>
              </a>
            ))}
            {lastPo && (
              <a href="#po" className="nw-row">
                <span className="nw-kind news">PO 답변</span>
                <span className="nw-text"><b>PO</b>{snap.poUnread > 1 ? ` (${snap.poUnread})` : ''} · {preview(lastPo.body)}</span>
                <span className="nw-when">{ago(lastPo.created_at, now)}</span>
              </a>
            )}
            {freshPrs.map((p) => (
              <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="nw-row">
                <span className="nw-kind pr">PR 열림</span>
                <span className="nw-text"><b>{p.project_name} #{p.number}</b> · {p.title} · <span className="mono">{p.base} ← {p.head}</span></span>
                <span className="nw-when">GitHub ↗</span>
              </a>
            ))}
          </div>
        ) : <div className="nw-empty">새 소식이 없습니다.</div>}
      </section>

      <section id="nw-work" className="nw-sec">
        <h2>일하는 중</h2>
        {working.length ? (
          <div className="nw-rows">
            {working.map((t) => (
              <a key={t.id} href={`#team-${t.id}`} className="nw-row">
                <span className={`sdot ${dotOf(t)}`} />
                <span className="nw-text"><b>{t.title || t.name}</b> · {t.project_name ?? '프로젝트 없음'} · {t.state === 'paused' ? (t.paused_reason ?? '멈춤') : t.state === 'queued' ? '대기열' : t.busy_note ?? '진행 중'}</span>
                {t.lifetime === 'task' && <span className="nw-steps" aria-label={`${STAGE[Math.min(t.stage, 3)]} 단계`}>{STAGE.map((s, i) => <span key={s} className={i < t.stage ? 'd' : i === t.stage ? 'n' : ''} />)}</span>}
                {t.lifetime === 'task' && <span className="nw-when">{ago(t.started_at, now).replace(' 전', '')}</span>}
              </a>
            ))}
          </div>
        ) : <div className="nw-empty">지금 일하는 팀이 없습니다. PO에게 지시하거나 팀 채널에서 바로 시키세요.</div>}
      </section>

      {openPrs.length > 0 && (
        <section className="nw-sec">
          <h2>열린 PR</h2>
          <div className="pr-list">{openPrs.map((p) => <PrRow key={p.url} pr={p} snap={snap} />)}</div>
        </section>
      )}
    </div>
  );
}
