/** 여러 화면이 함께 쓰는 라벨·작은 조각. */
import { useState, type ReactNode } from 'react';
import { STAGES, type AgentView, type Priority, type TeamState, type TeamView } from '../../shared/types.ts';
import { avatar, toolKind } from './art.ts';

export const STATE_LABEL: Record<TeamState, string> = {
  running: '가동중', paused: '일시정지', waiting_human: '정지 · 확인 필요', queued: '생산대기', done: '생산완료', failed: '실패',
  idle: '대기', down: '응답 없음', reviving: '되살리는 중', archived: '보관됨',
};
export const PRI: Record<Priority, string> = { urgent: '긴급', normal: '보통', low: '낮음' };
export const KIND_LABEL: Record<string, string> = { instruction: '지시', handoff: '넘김', question: '질문', reply: '답변', report: '보고', review: '검토', engine: 'PO 엔진' };
export const MODE_LABEL = { session: '독립 세션', subagent: '서브에이전트' } as const;
export const AGENT_STATE_LABEL = { busy: '작업 중', idle: '쉬는 중', stop: '일시정지' } as const;

/** 로봇 그림(내부에서 esc 된 SVG 문자열). */
export function Robot({ agent, cls }: { agent: Pick<AgentView, 'model' | 'role_key' | 'role_name'>; cls?: string }) {
  return <span className="robot" dangerouslySetInnerHTML={{ __html: avatar(agent.model, toolKind(agent.role_key, agent.role_name), agent.role_name, cls) }} />;
}
export function Html({ html, className }: { html: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Steps({ stage }: { stage: number }) {
  return (
    <div className="steps">
      {STAGES.map((s, i) => (
        <span key={s} className="steps-i">
          {i > 0 && <span className="arrow">›</span>}
          <span className={`step ${i < stage ? 'done' : i === stage ? 'now' : ''}`}>{s}</span>
        </span>
      ))}
    </div>
  );
}

/** lamp 색은 상태 클래스로. 직속 팀 상태는 가까운 색으로 옮긴다. */
export function lampState(s: TeamState): string {
  if (s === 'down') return 'waiting_human';
  if (s === 'reviving') return 'paused';
  if (s === 'idle') return 'queued';
  return s;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function duration(ms: number): string {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}
export function elapsed(t: TeamView, now: number): string {
  if (!t.started_at) return '-';
  const end = t.finished_at ? new Date(t.finished_at).getTime() : now;
  return duration(end - new Date(t.started_at).getTime());
}
export function agoSec(iso: string | null, now: number): string {
  if (!iso) return '기록 없음';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 120) return `${s}초 전`;
  return `${duration(s * 1000)} 전`;
}
export const money = (n: number) => `$${n.toFixed(2)}`;

/** 한 번 더 누르게 하는 버튼(중단·삭제 등). */
export function ConfirmButton({ label, confirmLabel, onConfirm, className = 'btn', disabled }: { label: string; confirmLabel: string; onConfirm: () => void; className?: string; disabled?: boolean }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button className={className} type="button" disabled={disabled} onClick={() => setAsk(true)}>{label}</button>;
  return (
    <span className="confirm">
      <span>{confirmLabel}</span>
      <button className="btn danger" type="button" onClick={() => { setAsk(false); onConfirm(); }}>확인</button>
      <button className="btn" type="button" onClick={() => setAsk(false)}>취소</button>
    </span>
  );
}

export function Section({ title, sub, right, children }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="section-h"><h2>{title}</h2>{right ?? (sub ? <span>{sub}</span> : null)}</div>
      {children}
    </section>
  );
}

/** PO 글: 줄바꿈과 **굵게** 정도만. HTML 은 넣지 않는다. */
export function RichText({ text }: { text: string }) {
  const paras = text.split(/\n{2,}/);
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}>
          {p.split('\n').map((line, j) => (
            <span key={j}>{j > 0 && <br />}{line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((seg, k) => seg.startsWith('**') && seg.endsWith('**') && seg.length > 4 ? <b key={k}>{seg.slice(2, -2)}</b> : seg.startsWith('`') && seg.endsWith('`') && seg.length > 2 ? <code key={k}>{seg.slice(1, -1)}</code> : seg)}</span>
          ))}
        </p>
      ))}
    </>
  );
}

/** 링크는 #·/·http(s) 만 허용. */
export function safeHref(h: string): string | null {
  if (h.startsWith('#') || (h.startsWith('/') && !h.startsWith('//'))) return h;
  if (/^https?:\/\//i.test(h)) return h;
  return null;
}
