import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatView, Model, Priority, ProposalView, RunMode, StateSnapshot, TemplateRole } from '../../shared/types.ts';
import { MODEL_LABEL } from './art.ts';
import { act, api, chat, proposalOutcome, refreshState, useBox } from './store.ts';
import { MODE_LABEL, RichText, hhmm, safeHref } from './ui.tsx';

const HINTS = ['팀들 지금 어디까지 했어?', '어제 바뀐 파일 알려줘'];

function ProposalCard({ p, snap }: { p: ProposalView; snap: StateSnapshot }) {
  const [roles, setRoles] = useState<TemplateRole[]>(() => p.roles.map((r) => ({ ...r })));
  const [projectId, setProjectId] = useState<string>(p.project_id ?? '');
  const [priority, setPriority] = useState<Priority>(p.priority);
  const [budget, setBudget] = useState<string>(p.budget_usd != null ? String(p.budget_usd) : String(snap.settings.defaultBudgetUsd));
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const remote = snap.access === 'remote';
  const sessions = roles.filter((r) => r.mode === 'session').length;

  const setRole = (i: number, patch: Partial<TemplateRole>) => setRoles((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const approve = async (confirm: boolean) => {
    const b = budget.trim() === '' ? null : Number(budget);
    if (b !== null && (!Number.isFinite(b) || b <= 0)) { void act(() => Promise.reject(new Error('예산은 0보다 큰 숫자여야 합니다'))); return; }
    setBusy(true);
    const r = await act(() => api(`/api/proposals/${encodeURIComponent(p.id)}/approve`, 'POST', { roles, priority, project_id: projectId || null, budget_usd: b, ...(confirm ? { confirm: true } : {}) }), '승인했습니다 · 팀을 만들었습니다');
    setBusy(false); setConfirming(false);
    if (r !== undefined) { proposalOutcome.set((o) => ({ ...o, [p.id]: 'approved' })); await refreshState(); }
  };
  const reject = async () => {
    setBusy(true);
    const r = await act(() => api(`/api/proposals/${encodeURIComponent(p.id)}/reject`, 'POST', {}));
    setBusy(false);
    if (r !== undefined) { proposalOutcome.set((o) => ({ ...o, [p.id]: 'rejected' })); await refreshState(); }
  };

  return (
    <div className="proposal">
      <div className="pr-title"><b>{p.title}</b>{p.template_name && <span className="muted"> · 템플릿 「{p.template_name}」</span>}</div>
      {p.brief && <details className="pr-brief"><summary>지시서 보기</summary><div className="prompt pre">{p.brief}</div></details>}
      <table>
        <tbody>
          {roles.map((r, i) => (
            <tr key={r.key}>
              <td><b>{r.name}</b> <span className="muted mono">{r.key}</span></td>
              <td>{editing ? (
                <select aria-label={`${r.name} 모델`} value={r.model} onChange={(e) => setRole(i, { model: e.target.value as Model })}>
                  <option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
                </select>
              ) : MODEL_LABEL[r.model]}</td>
              <td className="muted">{editing && r.key !== 'pm' ? (
                <select aria-label={`${r.name} 실행 방식`} value={r.mode} onChange={(e) => setRole(i, { mode: e.target.value as RunMode })}>
                  <option value="session">독립 세션</option><option value="subagent">서브에이전트</option>
                </select>
              ) : MODE_LABEL[r.key === 'pm' ? 'session' : r.mode]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? (
        <div className="pr-fields">
          <label>프로젝트
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">(없음)</option>
              {snap.projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
            </select>
          </label>
          <label>우선순위
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="urgent">긴급</option><option value="normal">보통</option><option value="low">낮음</option>
            </select>
          </label>
          <label>예산 $<input className="num" type="number" min="0" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
        </div>
      ) : (
        <div className="muted pr-meta">{p.project_name ?? snap.projects.find((x) => x.id === projectId)?.name ?? '프로젝트 없음'} · 우선순위 {({ urgent: '긴급', normal: '보통', low: '낮음' } as const)[priority]} · 세션 {sessions}개 · 예산 {budget ? `$${budget}` : '없음'}</div>
      )}
      {p.note && p.note !== p.title && <div className="muted pr-meta">{p.note}</div>}
      {confirming ? (
        <div className="confirm">원격 접속입니다. 이 구성으로 시작할까요?
          <button className="btn primary" type="button" disabled={busy} onClick={() => void approve(true)}>네, 시작</button>
          <button className="btn" type="button" onClick={() => setConfirming(false)}>취소</button>
        </div>
      ) : (
        <div className="row">
          <button className="btn primary" type="button" disabled={busy} onClick={() => (remote ? setConfirming(true) : void approve(false))}>승인하고 시작</button>
          <button className="btn" type="button" onClick={() => setEditing(!editing)}>{editing ? '수정 끝' : '구성 수정'}</button>
          <button className="btn" type="button" disabled={busy} onClick={() => void reject()}>거절</button>
        </div>
      )}
    </div>
  );
}

function Links({ links }: { links: ChatView['links'] }) {
  const ok = links.map((l) => ({ ...l, href: safeHref(l.href) })).filter((l): l is { label: string; href: string } => !!l.href);
  if (!ok.length) return null;
  return <div className="ev-links">{ok.map((l, i) => <a key={i} className="ev-link" href={l.href} {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>{l.label}</a>)}</div>;
}

function Row({ c, snap, outcome }: { c: ChatView; snap: StateSnapshot; outcome: Record<string, 'approved' | 'rejected'> }) {
  if (c.role === 'event') return <div className={`c ev ${c.tone ?? ''}`}><span className="mono c-t">{hhmm(c.created_at)}</span> {c.body}<Links links={c.links} /></div>;
  if (c.role === 'user') return <div className="c user"><RichText text={c.body} /></div>;
  const prop = c.proposal_id ? snap.proposals.find((p) => p.id === c.proposal_id) : undefined;
  const pending = prop?.status === 'pending' ? prop : undefined;
  const done = c.proposal_id && !pending ? (outcome[c.proposal_id] ?? (prop && prop.status !== 'pending' ? prop.status : undefined)) : undefined;
  return (
    <div className="c po">
      <RichText text={c.body} />
      {pending && <ProposalCard p={pending} snap={snap} />}
      {c.proposal_id && !pending && <div className={`pr-done ${done ?? ''}`}>{done === 'approved' ? '승인됨' : done === 'rejected' ? '거절됨' : '처리됨 (승인 또는 거절)'}</div>}
      <Links links={c.links} />
    </div>
  );
}

export function Chat({ snap }: { snap: StateSnapshot }) {
  const rows = useBox(chat);
  const outcome = useBox(proposalOutcome);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, snap.poBusy]);

  const send = async (v: string) => {
    if (!v.trim() || sending) return;
    setSending(true);
    stick.current = true;
    const r = await act(() => api('/api/chat', 'POST', { text: v.trim() }));
    setSending(false);
    if (r !== undefined) setText('');
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void send(text); };

  return (
    <aside className="chat" aria-label="PO 대화창">
      <div className="chat-h"><b>PO</b><span className={snap.poBusy ? 'po-busy' : ''}>{snap.poBusy ? 'PO 에이전트 · 생각 중…' : 'PO 에이전트 · 대기 (이벤트 때만 깨어남)'}</span></div>
      <div className="chat-body" ref={bodyRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {rows.length === 0 && <div className="c ev">PO에게 할 일을 지시하거나 진행 상황을 물어보세요. PO가 팀 구성을 제안하면 여기서 승인합니다.</div>}
        {rows.map((c) => <Row key={c.id} c={c} snap={snap} outcome={outcome} />)}
        {snap.poBusy && <div className="c po thinking">생각 중 <span className="typing"><span /><span /><span /></span></div>}
      </div>
      <div className="chat-f">
        <div className="hints">{HINTS.map((h) => <button key={h} className="hint" type="button" disabled={sending} onClick={() => void send(h)}>{h}</button>)}</div>
        <form onSubmit={submit}>
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="PO에게 지시하거나 질문하기" aria-label="PO에게 보낼 메시지" />
          <button className="btn primary" type="submit" disabled={sending || !text.trim()}>보내기</button>
        </form>
      </div>
    </aside>
  );
}
