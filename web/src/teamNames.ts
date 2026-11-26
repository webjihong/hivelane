/** 팀 id → 이름 사전(끝난·보관 팀 포함). 처음 쓸 때 서버에서 받고, 모르는 id 를 만나면 다시 받는다(10초에 한 번까지). */
import { useSyncExternalStore } from 'react';

let names: Record<string, string> = {};
let version = 0;
let loading: Promise<void> | null = null;
let lastFetch = 0;
const subs = new Set<() => void>();

function fetchNames(): void {
  if (loading || Date.now() - lastFetch < 10_000) return;
  lastFetch = Date.now();
  if (typeof fetch !== 'function' || typeof location === 'undefined') return;
  loading = fetch('/api/team-names', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() as Promise<{ names: Record<string, string> }> : Promise.reject(new Error(String(r.status)))))
    .then((r) => { names = r.names; version++; subs.forEach((f) => f()); })
    .catch(() => {})
    .finally(() => { loading = null; });
}

/** 지금 아는 이름(없으면 undefined). 모르는 id 면 사전을 다시 받아 온다 */
export function teamName(id: string): string | undefined {
  const n = names[id];
  if (n === undefined) fetchNames();
  return n;
}

/** 사전이 바뀌면 다시 그리게 */
export function useTeamNames(): number {
  return useSyncExternalStore((f) => { subs.add(f); if (!version) fetchNames(); return () => subs.delete(f); }, () => version, () => version);
}

/** 테스트·미리 아는 이름 넣기 */
export function primeTeamNames(n: Record<string, string>): void { names = { ...names, ...n }; version++; lastFetch = Date.now(); subs.forEach((f) => f()); }
