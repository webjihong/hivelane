import { existsSync } from 'node:fs';
import { run } from './util.ts';

/** 원격 접속(Tailscale serve) 상태: 설정 화면이 상태에 맞는 안내를 고르게 한다 */
export interface TailscaleState {
  installed: boolean;
  /** Running · Stopped · NeedsLogin … (모르면 null) */
  backend: string | null;
  /** 이 맥의 tailnet 주소(끝 점 뺀 것) */
  host: string | null;
  /** 원격 리스너(remotePort)로 serve 가 연결돼 있는가 */
  serving: boolean;
  url: string | null;
  /** serve 가 다른 곳(다른 포트)으로만 연결돼 있으면 그 대상 */
  otherTargets: string[];
  /** funnel(인터넷 공개)이 켜져 있으면 true — 위험 */
  funnel: boolean;
  error: string | null;
}

export function tailscaleBin(): string | null {
  for (const p of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) if (existsSync(p)) return p;
  return null;
}

type ServeJson = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };

/** serve status --json 해석(순수 함수, 테스트용) */
export function parseServe(j: ServeJson, remotePort: number): { serving: boolean; url: string | null; otherTargets: string[]; funnel: boolean } {
  let url: string | null = null;
  const other: string[] = [];
  for (const [hostPort, w] of Object.entries(j.Web ?? {})) {
    for (const h of Object.values(w.Handlers ?? {})) {
      const target = h.Proxy ?? '';
      if (new RegExp(`:${remotePort}(/|$)`).test(target)) { const [host, port] = hostPort.split(':'); url ??= `https://${host}${port && port !== '443' ? `:${port}` : ''}`; }
      else if (target) other.push(target);
    }
  }
  return { serving: !!url, url, otherTargets: other, funnel: Object.values(j.AllowFunnel ?? {}).some(Boolean) };
}

/** 앱 번들 CLI 는 TERM 이 없으면(launchd) CLI 가 아니라 GUI 로 뜨려다 실패한다 */
/** 앱용 Tailscale 실행 파일은 터미널이 아니면 GUI 로 뜨려 한다 → CLI 로 돌게 표시한다 */
const cliEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TERM: process.env.TERM || 'xterm-256color', TAILSCALE_BE_CLI: '1' });

let cache: { at: number; v: TailscaleState } | null = null;

export async function tailscaleState(remotePort: number, fresh = false): Promise<TailscaleState> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.v;
  const bin = tailscaleBin();
  let v: TailscaleState = { installed: !!bin, backend: null, host: null, serving: false, url: null, otherTargets: [], funnel: false, error: null };
  if (bin) {
    const st = await run(bin, ['status', '--json'], { timeoutMs: 8000, env: cliEnv() });
    try { const d = JSON.parse(st.stdout) as { BackendState?: string; Self?: { DNSName?: string } }; v.backend = d.BackendState ?? null; v.host = d.Self?.DNSName?.replace(/\.$/, '') ?? null; } catch { v.error = (st.stderr || st.stdout).trim().slice(0, 200) || 'tailscale 상태를 읽지 못했습니다'; }
    if (v.backend === 'Running') {
      const sv = await run(bin, ['serve', 'status', '--json'], { timeoutMs: 8000, env: cliEnv() });
      try { v = { ...v, ...parseServe(JSON.parse(sv.stdout || '{}') as ServeJson, remotePort) }; } catch { v.error = (sv.stderr || sv.stdout).trim().slice(0, 200) || 'serve 상태를 읽지 못했습니다'; }
    }
  }
  cache = { at: Date.now(), v };
  return v;
}
