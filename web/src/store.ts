/** 화면 상태: 스냅샷·대화·연결·라우트·토스트. useSyncExternalStore 로 구독한다. SSE 로 서버 변경을 받는다. */
import { useSyncExternalStore } from 'react';
import type { ChatView, ResourceView, StateSnapshot, UsageView } from '../../shared/types.ts';

/* ---------- 작은 스토어 ---------- */
export interface Box<T> { get(): T; set(v: T | ((p: T) => T)): void; subscribe(fn: () => void): () => void }
export function box<T>(init: T): Box<T> {
  let v = init;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(n) { v = typeof n === 'function' ? (n as (p: T) => T)(v) : n; subs.forEach((f) => f()); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
export function useBox<T>(b: Box<T>): T { return useSyncExternalStore(b.subscribe, b.get, b.get); }

/* ---------- API ---------- */
function errorText(j: unknown, status: number): string {
  if (j && typeof j === 'object' && 'error' in j) {
    const e = (j as { error: unknown; detail?: unknown }).error;
    const detail = (j as { detail?: unknown }).detail;
    const extra = Array.isArray(detail) ? ` (${detail.map(String).join(', ')})` : '';
    return `${String(e)}${extra}`;
  }
  return `요청 실패 (HTTP ${status})`;
}

export async function api<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
  let r: Response;
  try {
    const write = method !== 'GET';
    r = await fetch(path, {
      method,
      // 서버는 변경 요청에 JSON + X-Hivelane 헤더를 요구한다(CSRF 차단)
      headers: write ? { 'content-type': 'application/json', 'x-hivelane': '1' } : undefined,
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new Error('서버에 연결할 수 없습니다');
  }
  const j: unknown = await r.json().catch(() => null);
  if (!r.ok) throw new Error(errorText(j, r.status));
  return j as T;
}

/* ---------- 토스트 ---------- */
export interface Toast { id: number; text: string; tone: 'crit' | 'good' | 'info' }
export const toasts = box<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = ++toastSeq;
  toasts.set((l) => [...l.slice(-3), { id, text, tone }]);
  setTimeout(() => toasts.set((l) => l.filter((t) => t.id !== id)), tone === 'crit' ? 7000 : 3500);
}
/** 동작을 실행하고 실패하면 토스트. 성공 여부를 돌려준다. */
export async function act<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (okText) toast(okText, 'good');
    return r;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'crit');
    return undefined;
  }
}

/* ---------- 라우트 ---------- */
/** home: 데스크톱은 「지금 볼 것」, 휴대폰은 채널 목록 · now: 「지금 볼 것」 · list: 채널 목록(휴대폰) */
export type Route = { name: 'home' | 'now' | 'list' | 'po' | 'scripts' | 'templates' } | { name: 'settings'; tab?: string } | { name: 'prs'; focus?: string } | { name: 'finished'; tab: 'teams' | 'log' } | { name: 'team'; id: string; detail?: boolean };
function parseRoute(): Route {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('team-')) { const id = h.slice(5); return id.endsWith('/detail') ? { name: 'team', id: id.slice(0, -7), detail: true } : { name: 'team', id }; }
  if (h.startsWith('prs/')) return { name: 'prs', focus: h.slice(4) };
  if (h === 'scripts') return { name: 'scripts' };
  if (h === 'finished' || h === 'finished/log') return { name: 'finished', tab: h === 'finished/log' ? 'log' : 'teams' };
  if (h.startsWith('settings/')) return { name: 'settings', tab: h.slice(9) };
  if (h === 'po' || h === 'templates' || h === 'settings' || h === 'now' || h === 'list' || h === 'prs') return { name: h };
  return { name: 'home' };
}
export const route = box<Route>(parseRoute());
window.addEventListener('hashchange', () => { route.set(parseRoute()); window.scrollTo(0, 0); });
export const go = (hash: string): void => { location.hash = hash; };

/* ---------- 상태 ---------- */
export const snapshot = box<StateSnapshot | null>(null);
export const chat = box<ChatView[]>([]);
export const conn = box<'connecting' | 'ok' | 'down'>('connecting');
export const openAgent = box<string | null>(null);
/** 이번 세션에서 처리한 제안의 결과(승인/거절). 서버는 대기 중 제안만 준다. */
export const proposalOutcome = box<Record<string, 'approved' | 'rejected'>>({});

/** 서버가 화면보다 옛 버전(재시작 전)이어도 새 목록 값이 비지 않게 */
function withDefaults(s: StateSnapshot): StateSnapshot {
  return { ...s, prs: s.prs ?? [], prErrors: s.prErrors ?? {}, repos: s.repos ?? [], scripts: s.scripts ?? [], finishedCount: s.finishedCount ?? { done: 0, failed: 0, archived: 0 }, gitClean: s.gitClean ?? { remove: 0, ask: 0, takenAt: null, running: false }, usage: s.usage ?? { available: false, plan: null, windows: [], takenAt: null, error: null }, poUnread: s.poUnread ?? 0, knowledgeCount: s.knowledgeCount ?? 0 };
}

export async function refreshState(): Promise<void> {
  try { snapshot.set(withDefaults(await api<StateSnapshot>('/api/state'))); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'crit'); }
}
export async function refreshChat(): Promise<void> {
  try { chat.set(await api<ChatView[]>('/api/chat')); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'crit'); }
}

/* ---------- 버스(SSE 이벤트를 화면 조각에 나눠 준다) ---------- */
export interface AgentEvent { id: number; agent_id: string; team_id: string | null; kind: string; name: string | null; body: string; created_at: string }
export type LiveEvent = { type: 'state' } | { type: 'agent_event'; agentId: string; teamId: string | null; event: AgentEvent } | { type: 'script_out'; runId: number; chunk: string };
const liveSubs = new Set<(e: LiveEvent) => void>();
export function onLive(fn: (e: LiveEvent) => void): () => void { liveSubs.add(fn); return () => { liveSubs.delete(fn); }; }
const emitLive = (e: LiveEvent): void => liveSubs.forEach((f) => f(e));

export function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}
const refetchState = debounce(() => { void refreshState(); }, 250);

interface RawChatRow { id: number; role: string; body: string; proposal_id: string | null; links: string | null; tone: string | null; team_id: string | null; created_at: string }
function toChat(r: RawChatRow): ChatView {
  let links: ChatView['links'] = [];
  if (r.links) { try { const p: unknown = JSON.parse(r.links); if (Array.isArray(p)) links = p.filter((x): x is { label: string; href: string } => !!x && typeof x === 'object' && typeof (x as { label?: unknown }).label === 'string' && typeof (x as { href?: unknown }).href === 'string'); } catch { /* 링크 없음 */ } }
  const role: ChatView['role'] = r.role === 'user' || r.role === 'po' ? r.role : 'event';
  return { id: r.id, role, body: r.body, proposal_id: r.proposal_id, links, tone: r.tone, team_id: r.team_id, created_at: r.created_at };
}
function parse<T>(ev: Event): T | null {
  if (!(ev instanceof MessageEvent) || typeof ev.data !== 'string') return null;
  try { return JSON.parse(ev.data) as T; } catch { return null; }
}

let es: EventSource | null = null;
let backoff = 1000;
export function connect(): void {
  es?.close();
  const s = new EventSource('/api/events');
  es = s;
  s.addEventListener('hello', () => {
    const wasDown = conn.get() !== 'ok';
    conn.set('ok'); backoff = 1000;
    if (wasDown) { void refreshState(); void refreshChat(); emitLive({ type: 'state' }); }
  });
  s.addEventListener('state', () => { refetchState(); emitLive({ type: 'state' }); });
  s.addEventListener('resource', (ev) => {
    const d = parse<{ sample: ResourceView }>(ev);
    if (d?.sample) snapshot.set((p) => (p ? { ...p, resource: d.sample } : p));
  });
  s.addEventListener('usage', (ev) => {
    const d = parse<{ usage: UsageView }>(ev);
    if (d?.usage) snapshot.set((p) => (p ? { ...p, usage: d.usage } : p));
  });
  s.addEventListener('chat', (ev) => {
    const d = parse<{ row: RawChatRow }>(ev);
    if (!d?.row) return;
    const row = toChat(d.row);
    chat.set((l) => (l.some((c) => c.id === row.id) ? l : [...l, row]));
    if (row.proposal_id) refetchState();
  });
  s.addEventListener('agent_event', (ev) => {
    const d = parse<{ agentId: string; teamId: string | null; event: AgentEvent }>(ev);
    if (d) emitLive({ type: 'agent_event', agentId: d.agentId, teamId: d.teamId, event: d.event });
  });
  s.addEventListener('script_out', (ev) => {
    const d = parse<{ runId: number; chunk: string }>(ev);
    if (d) emitLive({ type: 'script_out', runId: d.runId, chunk: d.chunk });
  });
  s.onerror = () => {
    s.close();
    if (es !== s) return;
    conn.set('down');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

/* ---------- 매초 시계 ---------- */
export const clock = box<number>(Date.now());
setInterval(() => clock.set(Date.now()), 1000);
