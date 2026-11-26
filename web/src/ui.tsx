/** 여러 화면이 함께 쓰는 라벨·작은 조각. */
import { shortName, splitTeamRefs } from '../../shared/teamRefs.ts';
import { teamName, useTeamNames } from './teamNames.ts';
import { useState, type ReactNode } from 'react';
import { STAGES, type AgentView, type Priority, type TeamState, type TeamView } from '../../shared/types.ts';
import { avatar, toolKind } from './art.ts';

export const STATE_LABEL: Record<TeamState, string> = {
  running: '가동중', paused: '일시정지', waiting_human: '정지 · 확인 필요', queued: '생산대기', done: '생산완료', failed: '실패',
  idle: '대기', down: '응답 없음', reviving: '되살리는 중', archived: '보관됨',
};
export const PRI: Record<Priority, string> = { urgent: '긴급', normal: '보통', low: '낮음' };
/** 기록에 남은 이름(예전 「PO」)을 화면 이름으로 */
export function whoLabel(l: string | null | undefined): string { return l === 'PO' ? '총괄' : l === 'PO 엔진' ? '총괄 엔진' : l ?? ''; }
export const KIND_LABEL: Record<string, string> = { instruction: '지시', handoff: '넘김', question: '질문', reply: '답변', report: '보고', review: '검토', engine: '총괄 엔진' };
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

/** 총괄 글: 줄바꿈과 **굵게** 정도만. HTML 은 넣지 않는다. */
/** 굵게·코드·[글](주소)·맨 주소 링크. 링크는 safeHref 를 통과한 것만. */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\([^\s)]+\)|https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"」』])/;
function link(k: number, href: string, label: ReactNode): ReactNode {
  const h = safeHref(href);
  if (!h) return label;
  return <a key={k} href={h} {...(h.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>{label}</a>;
}
/** 팀 칩: 「이름 · id」 · 누르면 그 팀 화면 · 긴 제목은 줄이고 전체는 툴팁 */
export function TeamChip({ id, name }: { id: string; name: string }) {
  return <a className="team-ref" href={`#team-${id}`} title={`${name} · ${id}`}><span className="team-ref-n">{shortName(name)}</span><span className="team-ref-id">{id}</span></a>;
}
/** 글 속 팀 id → 팀 칩(모르는 id 는 그대로) */
function teamRefs(text: string, key: number): ReactNode[] {
  if (!/(?:tm|s)-[a-z0-9]{6}/.test(text)) return [text];
  return splitTeamRefs(text, (id) => { const n = teamName(id); return n ? { name: n } : undefined; })
    .map((p, j) => (typeof p === 'string' ? p : <TeamChip key={`${key}-${j}`} id={p.id} name={p.name} />));
}
function inline(line: string): ReactNode[] {
  return line.split(INLINE).flatMap((seg, k): ReactNode[] => {
    if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) return [<b key={k}>{teamRefs(seg.slice(2, -2), k)}</b>];
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      // `tm-…` 처럼 팀 id 하나만 감싼 것은 칩으로(칩에도 id 가 그대로 보임)
      const code = seg.slice(1, -1);
      const n = /^(?:tm|s)-[a-z0-9]{6,12}$/.test(code) ? teamName(code) : undefined;
      return [n ? <TeamChip key={k} id={code} name={n} /> : <code key={k}>{code}</code>];
    }
    const m = seg.match(/^\[([^\]\n]+)\]\(([^\s)]+)\)$/);
    if (m) return [link(k, m[2]!, m[1]!)];
    if (/^https?:\/\//.test(seg)) return [link(k, seg, seg)];
    return teamRefs(seg, k);
  });
}

/** 줄바꿈 없는 긴 문단(180자↑)은 문장 끝에서 나눠 한 줄씩 보여 준다. 소수점·약어는 나누지 않는다. */
export function splitSentences(line: string): string[] {
  if (line.length < 180) return [line];
  const parts = line.split(/(?<=(?:[다요음함됨임죠니까]|[)」』"'])[.!?])\s+(?=\S)/u);
  return parts.length > 1 ? parts : [line];
}

type Block = { t: 'code'; lines: string[] } | { t: 'p'; lines: string[] } | { t: 'img'; src: string; alt: string } | { t: 'h'; text: string } | { t: 'ul'; items: string[] } | { t: 'ol'; items: string[] } | { t: 'table'; rows: string[][] };

/** 가벼운 마크다운: 제목·목록·표·굵게·코드. 첫 줄이 「결론」이면 강조한다. */
export function RichText({ text }: { text: string }) {
  useTeamNames(); // 팀 이름 사전이 오면 다시 그림
  const blocks: Block[] = [];
  const last = () => blocks[blocks.length - 1];
  let code: { t: 'code'; lines: string[] } | null = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    // ``` 코드 블록: 안은 그대로(팀 id 도 바꾸지 않음)
    if (/^\s*```/.test(line)) { if (code) code = null; else { code = { t: 'code', lines: [] }; blocks.push(code); } continue; }
    if (code) { code.lines.push(raw); continue; }
    if (!line.trim()) { blocks.push({ t: 'p', lines: [] }); continue; }
    if ((m = line.match(/^\s*!\[([^\]]*)\]\((\/api\/uploads\/u-[a-z0-9]{12}\.(?:png|jpg|gif|webp))\)\s*$/))) { blocks.push({ t: 'img', alt: m[1]!, src: m[2]! }); continue; }
    if ((m = line.match(/^\s{0,3}#{1,4}\s+(.*)$/))) { blocks.push({ t: 'h', text: m[1]! }); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { const b = last(); if (b?.t === 'ul') b.items.push(m[1]!); else blocks.push({ t: 'ul', items: [m[1]!] }); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { const b = last(); if (b?.t === 'ol') b.items.push(m[1]!); else blocks.push({ t: 'ol', items: [m[1]!] }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      const b = last(); if (b?.t === 'table') b.rows.push(cells); else blocks.push({ t: 'table', rows: [cells] });
      continue;
    }
    const split = splitSentences(line);
    if (split.length > 1) { blocks.push({ t: 'p', lines: [] }); blocks.push({ t: 'p', lines: split }); blocks.push({ t: 'p', lines: [] }); continue; }
    const b = last(); if (b?.t === 'p' && b.lines.length) b.lines.push(line); else blocks.push({ t: 'p', lines: [line] });
  }
  const shown = blocks.filter((b) => (b.t !== 'p' && b.t !== 'code') || b.lines.length);
  return (
    <div className="rt">
      {shown.map((b, i) => {
        if (b.t === 'code') return <pre key={i} className="rt-code"><code>{b.lines.join('\n')}</code></pre>;
        if (b.t === 'img') return <a key={i} href={b.src} target="_blank" rel="noreferrer"><img className="rt-img" src={b.src} alt={b.alt || '첨부 이미지'} loading="lazy" /></a>;
        if (b.t === 'h') return <div key={i} className="rt-h">{inline(b.text)}</div>;
        if (b.t === 'ul') return <ul key={i}>{b.items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ul>;
        if (b.t === 'ol') return <ol key={i}>{b.items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ol>;
        if (b.t === 'table') return <div key={i} className="rt-table"><table><thead><tr>{b.rows[0]!.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{b.rows.slice(1).map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody></table></div>;
        const lead = i === 0 && /^\**\s*결론/.test(b.lines[0]!);
        const sentences = b.lines.length > 2 && b.lines.every((l) => l.length < 400) && b.lines.join(' ').length >= 180;
        return <p key={i} className={lead ? 'rt-lead' : sentences ? 'rt-sent' : undefined}>{b.lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l)}</span>)}</p>;
      })}
    </div>
  );
}

/** 링크는 #·/·http(s) 만 허용. */
export function safeHref(h: string): string | null {
  if (h.startsWith('#') || (h.startsWith('/') && !h.startsWith('//'))) return h;
  if (/^https?:\/\//i.test(h)) return h;
  return null;
}
