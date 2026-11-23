import { useState, type ReactElement } from 'react';
import { STAGES, type StateSnapshot, type TeamState, type TeamView } from '../../shared/types.ts';
import { GEAR, binSvg } from './art.ts';
import { act, api, clock, go, refreshState, useBox } from './store.ts';
import { Html, PRI, Robot, STATE_LABEL, Section, agoSec, elapsed, money } from './ui.tsx';

const ORDER: Partial<Record<TeamState, number>> = { waiting_human: 0, failed: 1, running: 2, paused: 3, queued: 4, done: 5 };
const TILES: TeamState[] = ['running', 'paused', 'waiting_human', 'queued', 'done', 'failed'];

const post = (path: string, body?: unknown) => act(async () => { await api(path, 'POST', body ?? {}); await refreshState(); });

export const isLine = (t: TeamView) => t.lifetime === 'task' && t.state !== 'archived';
export const isStanding = (t: TeamView) => t.lifetime === 'standing' && t.state !== 'archived';

function sessions(t: TeamView): number { return t.agents.filter((a) => a.run_mode === 'session').length; }

function subText(t: TeamView): { text: string; cls: string } {
  if (t.state === 'waiting_human') return { text: t.question ? `PM의 질문: ${t.question.text}` : (t.paused_reason ?? '사람 확인 필요'), cls: 'crit' };
  if (t.state === 'paused') return { text: t.pause_kind?.startsWith('engine') ? `리소스 회복 시 자동 재개 · ${t.paused_reason ?? ''}` : (t.paused_reason ?? '일시정지'), cls: 'warn' };
  if (t.state === 'failed') return { text: t.error ?? '실패', cls: 'crit' };
  if (t.busy_note) return { text: t.busy_note, cls: '' };
  if (t.state === 'queued') return { text: t.paused_reason ?? '투입 대기', cls: '' };
  if (t.state === 'done') return { text: '생산완료', cls: '' };
  return { text: `${STAGES[Math.min(t.stage, 3)]} 단계`, cls: '' };
}

function Crew({ t }: { t: TeamView }) {
  return <>{t.agents.map((a) => <span key={a.id} className={`mini ${a.state}`} title={`${a.role_name} · ${a.model}`}><Robot agent={a} /></span>)}</>;
}

function RowLine({ t, now }: { t: TeamView; now: number }) {
  const sub = subText(t);
  return (
    <button className={`rline s-${t.state}`} type="button" onClick={() => go(`team-${t.id}`)}>
      <span className="lamp" />
      <span className="tagc"><span className={`tag ${t.state}`}>{STATE_LABEL[t.state]}</span></span>
      <div className="tt" style={{ minWidth: 0 }}>
        <div className="t1">{t.unread > 0 && <span className="unread" title="읽지 않은 답변">새 답변 {t.unread}</span>}{t.priority !== 'normal' && <><span className={`chip ${t.priority}`}>{PRI[t.priority]}</span> </>}{t.title}</div>
        <div className={`t2 ${sub.cls}`}>{t.project_name ? `${t.project_name} · ` : ''}{sub.text}</div>
      </div>
      <div className="sg">
        <div className="segs">{STAGES.map((s, i) => <span key={s} className={t.state === 'done' || i < t.stage ? 'd' : i === t.stage && t.state !== 'queued' ? 'n' : ''} />)}</div>
        <div className="segs-l">{STAGES.map((s) => <span key={s}>{s}</span>)}</div>
      </div>
      <div className="crew"><Crew t={t} /></div>
      <div className="num"><div className="mono">{money(t.cost_usd)}</div><div>{elapsed(t, now)}</div></div>
    </button>
  );
}

function LineCard({ t, now }: { t: TeamView; now: number }) {
  const to = `calc((100% - 64px) * ${((Math.min(t.stage, 3) + 0.5) / 4).toFixed(3)} - 6px)`;
  const sub = subText(t);
  const note = t.state === 'paused' ? <div className="line-note warn">{sub.text}</div>
    : t.state === 'waiting_human' || t.state === 'failed' ? <div className="line-note crit">{sub.text}</div>
    : t.state === 'done' ? <div className="line-note done">생산완료{t.finished_at ? ` · ${elapsed(t, now)} 걸림` : ''}</div>
    : t.state === 'queued' ? <div className="line-note muted">{t.paused_reason ?? '투입 대기'}</div> : null;
  return (
    <button className={`line s-${t.state}`} type="button" onClick={() => go(`team-${t.id}`)}>
      <div className="line-h"><span className="lamp" />
        <div className="ttl"><span className={`tag ${t.state}`}>{STATE_LABEL[t.state]}</span>{t.priority !== 'normal' && <span className={`chip ${t.priority}`}>{PRI[t.priority]}</span>}{t.unread > 0 && <span className="unread" title="읽지 않은 답변">새 답변 {t.unread}</span>}<span>{t.title}</span></div>
        <div className="rt"><div className="mono">{money(t.cost_usd)}</div><div>{elapsed(t, now)}</div></div>
      </div>
      <div className="floor" style={{ ['--to' as string]: to }}>
        <div className="belt" />
        <div className="stations">
          {STAGES.map((s, i) => {
            const cls = t.state === 'done' || i < t.stage ? 'done' : i === t.stage && t.state !== 'queued' ? 'now' : '';
            return (
              <div key={s} className={`station ${cls}`}>
                <div className="machine"><Html html={GEAR} className="gear-w" />{cls === 'done' ? <span className="ok-mark">✓</span> : cls === 'now' && (t.state === 'waiting_human' || t.state === 'failed') ? <span className="alert-mark">!</span> : null}</div>
                <span>{s}</span>
              </div>
            );
          })}
          <div className="bin"><Html html={binSvg(t.state === 'done')} className="bin-w" /><span>{t.state === 'done' ? '출하 대기' : '완성품'}</span></div>
        </div>
        <span className="pkg" /><span className="pkg" /><span className="pkg" />
      </div>
      {note}
      <div className="line-f">
        <div className="crew"><Crew t={t} /><span style={{ marginLeft: 6 }}>{t.agents.map((a) => a.role_name).join(' · ')}</span></div>
        <span>세션 {sessions(t)}개{t.pinned ? ' · 멈추지 않음' : ''}{t.branch ? <> · <span className="mono">{t.branch}</span></> : null}</span>
      </div>
    </button>
  );
}

function facility(t: TeamView): string {
  const kind = t.check_command ? 'radar' : 'siren';
  const st = t.state === 'running' || t.state === 'waiting_human' ? 'busy' : t.state === 'down' ? 'down' : t.state === 'reviving' ? 'reviving' : 'idle';
  return `facility ${kind} ${st}`;
}

function Alerts({ snap }: { snap: StateSnapshot }) {
  const teams = snap.teams.filter((t) => t.state !== 'archived');
  const items: ReactElement[] = [];
  for (const t of teams.filter((x) => x.state === 'waiting_human')) {
    items.push(
      <div key={`q-${t.id}`} className="alert crit"><span className="lamp waiting_human" />
        <div style={{ minWidth: 0 }}><div className="a-t">{t.title}</div><div className="a-s">{t.question ? `PM의 질문: ${t.question.text}` : (t.paused_reason ?? '사람 확인 필요')}</div></div>
        <div className="acts">
          {(t.question?.options ?? []).map((o) => <button key={o} className="btn" type="button" onClick={() => void post(`/api/teams/${t.id}/answer`, { text: o })}>{o}</button>)}
          <button className="btn primary" type="button" onClick={() => go(`team-${t.id}`)}>직접 답하기</button>
        </div>
      </div>,
    );
  }
  for (const t of teams.filter((x) => x.state === 'failed')) {
    items.push(
      <div key={`f-${t.id}`} className="alert crit"><span className="lamp failed" />
        <div style={{ minWidth: 0 }}><div className="a-t">{t.title}</div><div className="a-s">실패: {t.error ?? '이유 없음'}</div></div>
        <div className="acts"><button className="btn" type="button" onClick={() => void post(`/api/teams/${t.id}/retry`)}>다시 시작</button><button className="btn" type="button" onClick={() => go(`team-${t.id}`)}>열기</button></div>
      </div>,
    );
  }
  // 엔진이 멈춘 팀은 리소스가 돌아오면 엔진이 알아서 재개하므로 사람이 할 일이 아니다
  for (const t of teams.filter((x) => x.state === 'paused' && x.lifetime === 'task' && !x.pause_kind?.startsWith('engine'))) {
    items.push(
      <div key={`p-${t.id}`} className="alert warn"><span className="lamp paused" />
        <div style={{ minWidth: 0 }}><div className="a-t">{t.title}</div><div className="a-s">{t.paused_reason ?? '일시정지'}</div></div>
        <div className="acts"><button className="btn" type="button" onClick={() => void post(`/api/teams/${t.id}/resume`)}>재개</button><button className="btn" type="button" onClick={() => go(`team-${t.id}`)}>열기</button></div>
      </div>,
    );
  }
  for (const t of teams.filter((x) => x.lifetime === 'standing' && (x.state === 'down' || x.state === 'reviving'))) {
    items.push(
      <div key={`s-${t.id}`} className="alert crit"><span className="lamp waiting_human" />
        <div style={{ minWidth: 0 }}><div className="a-t">{t.name}</div><div className="a-s">{t.state === 'down' ? `생존 확인 실패 · 자동 되살리기 시작${t.error ? ` · ${t.error}` : ''}` : '되살리는 중 · 상시 지시서와 최근 요약을 읽는 중'}</div></div>
        <div className="acts"><button className="btn" type="button" onClick={() => go(`team-${t.id}`)}>열기</button></div>
      </div>,
    );
  }
  for (const t of teams.filter((x) => x.unread > 0 && x.state !== 'waiting_human')) {
    items.push(
      <div key={`u-${t.id}`} className="alert info"><span className="lamp done" />
        <div style={{ minWidth: 0 }}><div className="a-t">{t.title}</div><div className="a-s">읽지 않은 답변 {t.unread}건</div></div>
        <div className="acts"><button className="btn primary" type="button" onClick={() => go(`team-${t.id}`)}>읽기</button></div>
      </div>,
    );
  }
  if (snap.poUnread > 0) {
    items.push(
      <div key="u-po" className="alert info"><span className="lamp done" />
        <div style={{ minWidth: 0 }}><div className="a-t">PO</div><div className="a-s">읽지 않은 PO 답변 {snap.poUnread}건</div></div>
        <div className="acts"><button className="btn primary" type="button" onClick={() => go('po')}>읽기</button></div>
      </div>,
    );
  }
  return items.length ? <div className="alerts">{items}</div> : <div className="all-clear">지금 사람이 확인할 일은 없습니다. 모든 라인이 알아서 돌고 있습니다.</div>;
}

export function Home({ snap }: { snap: StateSnapshot }) {
  const now = useBox(clock);
  const [filter, setFilter] = useState<TeamState | null>(null);
  const [view, setView] = useState<'summary' | 'lines'>(() => { try { return localStorage.getItem('hl.view') === 'lines' ? 'lines' : 'summary'; } catch { return 'summary'; } });
  const pickView = (v: 'summary' | 'lines') => { setView(v); try { localStorage.setItem('hl.view', v); } catch { /* 저장 안 됨 */ } };

  const lines = snap.teams.filter(isLine);
  const standing = snap.teams.filter(isStanding);
  const count = (s: TeamState) => lines.filter((t) => t.state === s).length;
  let ts = [...lines].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || b.created_at.localeCompare(a.created_at));
  if (filter) ts = ts.filter((t) => t.state === filter);

  const empty = !lines.length;
  return (
    <>
      <Section title="조치 필요" sub="사람이 답하거나 결정할 일"><Alerts snap={snap} /></Section>
      <Section title="생산 현황판" sub="숫자를 누르면 그 상태만 보기">
        <div className="board six">
          {TILES.map((st) => (
            <button key={st} className={`tile ${filter === st ? 'on' : ''}`} type="button" aria-pressed={filter === st} onClick={() => setFilter(filter === st ? null : st)}>
              <span className={`lamp ${st}`} /><div><b>{count(st)}</b><small>{STATE_LABEL[st]}</small></div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="상시 설비" right={<span>직속 팀 · 눌러서 바로 지시 · <a className="link" href="#settings">직속 팀 추가</a></span>}>
        {standing.length ? (
          <div className="st-row">
            {standing.map((t) => (
              <button key={t.id} className="st-pill st" type="button" onClick={() => go(`team-${t.id}`)}>
                <span className={facility(t)} /><b>{t.name}</b>{t.unread > 0 && <span className="unread" title="읽지 않은 답변">새 답변 {t.unread}</span>}
                <span className="mono muted">{STATE_LABEL[t.state]} · 생존 확인 {agoSec(t.last_heartbeat_at, now)}</span>
              </button>
            ))}
          </div>
        ) : <div className="empty-line">직속 팀이 없습니다. 설정 › 직속 팀에서 만들 수 있습니다.</div>}
      </Section>
      <section>
        <div className="section-h">
          <h2>생산 라인{filter && <> · {STATE_LABEL[filter]}만 <button className="back" type="button" onClick={() => setFilter(null)}>전체 보기</button></>}</h2>
          <div className="view-tg" role="group" aria-label="보기 방식">
            <button type="button" className={view === 'summary' ? 'on' : ''} onClick={() => pickView('summary')}>요약</button>
            <button type="button" className={view === 'lines' ? 'on' : ''} onClick={() => pickView('lines')}>라인 보기</button>
          </div>
        </div>
        {empty ? (
          <div className="empty-box">
            <b>아직 생산 라인이 없습니다.</b>
            <span>{snap.projects.length ? '오른쪽 PO 대화창(모바일은 PO 탭)에서 할 일을 지시하면 PO가 팀 구성을 제안합니다.' : '설정 › 프로젝트에서 저장소를 등록하고 PO에게 지시하세요.'}</span>
            {!snap.projects.length && <a className="btn primary" href="#settings">프로젝트 등록하러 가기</a>}
          </div>
        ) : ts.length ? (
          view === 'summary' ? <div className="rows">{ts.map((t) => <RowLine key={t.id} t={t} now={now} />)}</div> : <div className="lines">{ts.map((t) => <LineCard key={t.id} t={t} now={now} />)}</div>
        ) : <div className="all-clear" style={{ color: 'var(--muted)', background: 'var(--surface-2)' }}>이 상태의 라인이 없습니다.</div>}
      </section>
    </>
  );
}

