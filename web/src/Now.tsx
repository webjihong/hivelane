import type { StateSnapshot, TeamView } from '../../shared/types.ts';
import { asks, dotOf, isApproval, nowCount } from './chan.ts';
import { PrRow } from './Prs.tsx';
import { t } from './i18n.ts';
import { act, api, chat, clock, go, refreshState, useBox } from './store.ts';

const STAGE = [t('기획'), t('구현'), t('검사'), t('보고')];

/** bare: 「전」 없이(경과 시간) */
function ago(iso: string | null | undefined, now: number, bare = false): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return t('방금');
  if (m < 60) return bare ? t('{n}분', { n: m }) : t('{n}분 전', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return bare ? t('{n}시간', { n: h }) : t('{n}시간 전', { n: h });
  const d = Math.round(h / 24);
  return bare ? t('{n}일', { n: d }) : t('{n}일 전', { n: d });
}
/** 미리보기 한 줄: 마크다운 기호 걷고 첫 문장 */
function preview(s: string): string {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, t('[이미지]')).replace(/[*`#>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function Need({ tm, snap }: { tm: TeamView; snap: StateSnapshot }) {
  const now = useBox(clock);
  const answer = (text: string) => act(async () => { await api(`/api/teams/${encodeURIComponent(tm.id)}/answer`, 'POST', { text }); await refreshState(); }, t('답을 보냈습니다'));
  const approval = isApproval(tm.question?.options);
  if (tm.state === 'failed') return (
    <article className="nw-card crit">
      <div className="nw-meta"><b>{tm.title || tm.name}</b> · {t('실패')} · {ago(tm.finished_at, now)}</div>
      <div className="nw-q">{tm.error ?? t('이유 없음')}</div>
      <div className="nw-acts"><button className="btn primary" type="button" onClick={() => void act(async () => { await api(`/api/teams/${tm.id}/retry`, 'POST', {}); await refreshState(); }, t('대기열에 다시 넣었습니다'))}>{t('다시 시작')}</button><a className="btn" href={`#team-${tm.id}`}>{t('채널 열기')}</a></div>
    </article>
  );
  if (tm.state === 'down' && !tm.question) return (
    <article className="nw-card crit">
      <div className="nw-meta"><b>{tm.name}</b> · {t('직속 팀 장애 · 자동으로 다시 살리는 중')}</div>
      <div className="nw-q">{tm.error ?? t('원인 확인 중')}</div>
      <div className="nw-acts"><a className="btn" href={`#team-${tm.id}`}>{t('채널 열기')}</a></div>
    </article>
  );
  return (
    <article className="nw-card ask">
      <div className="nw-meta"><b>{tm.title || tm.name}</b> · {approval ? t('명령 승인 요청') : t('PM 질문')} · {ago(tm.question?.asked_at, now)}</div>
      <div className="nw-q clamp3">{tm.question?.text ?? tm.paused_reason ?? t('사람 확인이 필요합니다')}</div>
      <div className="nw-acts">
        {(tm.question?.options ?? []).map((o, i) => <button key={o} className={`btn${i === 0 ? ' primary' : ''}`} type="button" onClick={() => void answer(o)}>{o}</button>)}
        <a className="btn ghost" href={`#team-${tm.id}`}>{t('채널에서 답하기')}</a>
      </div>
    </article>
  );
}

export function Now({ snap }: { snap: StateSnapshot }) {
  const now = useBox(clock);
  const rows = useBox(chat);
  const live = snap.teams.filter((tm) => tm.state !== 'archived');
  const needs = live.filter((tm) => asks(tm) || tm.state === 'waiting_human' || tm.state === 'failed' || tm.state === 'down');
  const proposals = snap.proposals.filter((p) => p.status === 'pending');
  const unread = live.filter((tm) => tm.unread > 0 && !asks(tm) && tm.state !== 'waiting_human');
  const lastPo = snap.poUnread ? [...rows].reverse().find((c) => c.role === 'po') : undefined;
  const freshPrs = snap.prs.filter((p) => p.state === 'OPEN' && now - Date.parse(p.updated_at) < 86_400_000);
  const working = live.filter((tm) => ['running', 'paused', 'queued', 'reviving'].includes(tm.state));
  const openPrs = snap.prs.filter((p) => p.state === 'OPEN');
  const { need, news } = nowCount(snap);

  const allRead = () => act(async () => {
    await Promise.all([...unread.map((tm) => api('/api/seen', 'POST', { team_id: tm.id })), ...(snap.poUnread ? [api('/api/seen', 'POST', { po: true })] : [])]);
    await refreshState();
  }, t('모두 읽음으로 표시했습니다'));

  return (
    <div className="nw">
      <header className="nw-h">
        <h1>{t('지금 볼 것')}</h1>
        <span className="muted">{need ? t('답·결정이 필요한 것 {n}', { n: need }) : t('답할 것 없음')} · {t('새 소식 {n}', { n: news })}</span>
        {news > 0 && <button type="button" className="link-btn" onClick={() => void allRead()}>{t('모두 읽음으로')}</button>}
      </header>

      <div className="nw-tiles">
        <button type="button" className={`nw-tile${need ? ' ask' : ''}`} onClick={() => document.getElementById('nw-need')?.scrollIntoView({ behavior: 'smooth' })}><b>{need}</b><span>{t('결정 기다림')}</span></button>
        <button type="button" className="nw-tile run" onClick={() => document.getElementById('nw-work')?.scrollIntoView({ behavior: 'smooth' })}><b>{working.filter((tm) => tm.state === 'running').length}</b><span>{t('일하는 팀')}</span></button>
        <button type="button" className="nw-tile pr" onClick={() => go('prs')}><b>{openPrs.length}</b><span>{t('열린 PR')}</span></button>
        <button type="button" className="nw-tile" onClick={() => document.getElementById('nw-news')?.scrollIntoView({ behavior: 'smooth' })}><b>{news}</b><span>{t('새 소식')}</span></button>
      </div>

      <section id="nw-need" className="nw-sec">
        <h2 className="ask-t">{t('내 답이 필요함')}</h2>
        {needs.length || proposals.length ? (
          <div className="nw-list">
            {needs.map((tm) => <Need key={tm.id} tm={tm} snap={snap} />)}
            {proposals.map((p) => (
              <article key={p.id} className="nw-card ask">
                <div className="nw-meta"><b>{t('총괄 팀 구성 제안')}</b> · {p.project_name ?? t('프로젝트 없음')}</div>
                <div className="nw-q">{p.title}</div>
                <div className="nw-acts"><a className="btn primary" href="#po">{t('총괄에서 승인·수정')}</a></div>
              </article>
            ))}
          </div>
        ) : <div className="nw-empty">{t('지금 답할 것은 없습니다.')}</div>}
      </section>

      <section id="nw-news" className="nw-sec">
        <h2 className="news-t">{t('새 소식')}</h2>
        {unread.length || lastPo || freshPrs.length ? (
          <div className="nw-rows">
            {unread.map((tm) => (
              <a key={tm.id} href={`#team-${tm.id}`} className="nw-row">
                <span className="nw-kind news">{t('새 답변')}</span>
                <span className="nw-text"><b>{tm.title || tm.name}</b>{tm.unread > 1 ? ` (${tm.unread})` : ''} · {preview(tm.last_msg?.body ?? '')}</span>
                <span className="nw-when">{ago(tm.last_msg?.at, now)}</span>
              </a>
            ))}
            {lastPo && (
              <a href="#po" className="nw-row">
                <span className="nw-kind news">{t('총괄 답변')}</span>
                <span className="nw-text"><b>{t('총괄')}</b>{snap.poUnread > 1 ? ` (${snap.poUnread})` : ''} · {preview(lastPo.body)}</span>
                <span className="nw-when">{ago(lastPo.created_at, now)}</span>
              </a>
            )}
            {freshPrs.map((p) => (
              <a key={p.url} href={`#prs/${p.project_id}:${p.number}`} className="nw-row">
                <span className="nw-kind pr">{t('PR 열림')}</span>
                <span className="nw-text"><b>{p.project_name} #{p.number}</b> · {p.title} · <span className="mono">{p.base} ← {p.head}</span></span>
                <span className="nw-when">{t('검사·병합 ›')}</span>
              </a>
            ))}
          </div>
        ) : <div className="nw-empty">{t('새 소식이 없습니다.')}</div>}
      </section>

      <section id="nw-work" className="nw-sec">
        <h2>{t('일하는 중')}</h2>
        {working.length ? (
          <div className="nw-rows">
            {working.map((tm) => (
              <a key={tm.id} href={`#team-${tm.id}`} className="nw-row">
                <span className={`sdot ${dotOf(tm)}`} />
                <span className="nw-text"><b>{tm.title || tm.name}</b> · {tm.project_name ?? t('프로젝트 없음')} · {tm.state === 'paused' ? (tm.paused_reason ?? t('멈춤')) : tm.state === 'queued' ? t('대기열') : tm.busy_note ?? t('진행 중')}</span>
                {tm.lifetime === 'task' && <span className="nw-steps" aria-label={t('{stage} 단계', { stage: STAGE[Math.min(tm.stage, 3)]! })}>{STAGE.map((s, i) => <span key={s} className={i < tm.stage ? 'd' : i === tm.stage ? 'n' : ''} />)}</span>}
                {tm.lifetime === 'task' && <span className="nw-when">{ago(tm.started_at, now, true)}</span>}
              </a>
            ))}
          </div>
        ) : <div className="nw-empty">{t('지금 일하는 팀이 없습니다. 총괄에게 지시하거나 팀 채널에서 바로 시키세요.')}</div>}
      </section>

      {openPrs.length > 0 && (
        <section className="nw-sec">
          <h2>{t('열린 PR')}</h2>
          <div className="pr-list">{openPrs.map((p) => <PrRow key={p.url} pr={p} snap={snap} />)}</div>
        </section>
      )}
    </div>
  );
}
