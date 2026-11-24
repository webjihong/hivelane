import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { UsageView, UsageWindow } from '../../shared/types.ts';
import { logger } from '../log.ts';

const log = logger('usage');

/** SDK /usage 응답에서 쓰는 부분만 */
type Win = { utilization: number | null; resets_at: string | null } | null | undefined;
export interface RawUsage {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: Record<string, Win | unknown> | null;
}

const WINDOWS: [key: string, label: string][] = [
  ['five_hour', '5시간'],
  ['seven_day', '주간'],
  ['seven_day_opus', '주간 Opus'],
  ['seven_day_sonnet', '주간 Sonnet'],
];

/** 응답 → 화면용. 5시간·주간은 값이 있으면 늘 싣고, 모델별 주간은 쓴 게 있을 때만 */
export function toView(r: RawUsage, now = new Date()): UsageView {
  const windows: UsageWindow[] = [];
  const rl = r.rate_limits ?? {};
  for (const [key, label] of WINDOWS) {
    const w = rl[key] as Win;
    if (!w || typeof w.utilization !== 'number') continue;
    if (key !== 'five_hour' && key !== 'seven_day' && w.utilization <= 0) continue;
    windows.push({ key, label, pct: Math.max(0, Math.min(100, w.utilization)), resets_at: w.resets_at });
  }
  return { available: r.rate_limits_available && windows.length > 0, plan: r.subscription_type, windows, takenAt: now.toISOString(), error: null };
}

/** 프롬프트 없이 claude 를 띄워 /usage 값만 묻고 닫는다(토큰 안 씀, 0.5초 남짓) */
async function sdkFetch(pathToClaude?: string): Promise<RawUsage> {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  async function* idle(): AsyncGenerator<never> { await hold; }
  const q = query({ prompt: idle(), options: { cwd: tmpdir(), settingSources: [], ...(pathToClaude ? { pathToClaudeCodeExecutable: pathToClaude } : {}) } });
  const timer = setTimeout(() => { release(); q.close(); }, 20_000);
  try {
    return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  } finally {
    clearTimeout(timer);
    release();
    q.close();
  }
}

/** Claude 플랜 사용량(5시간·주간 한도 대비 %). 5분마다, 그리고 팀 실행 중 한도 이벤트가 오면 1분 간격으로 갱신 */
export class PlanUsage {
  last: UsageView = { available: false, plan: null, windows: [], takenAt: null, error: null };
  private running: Promise<void> | null = null;
  private lastTry = 0;

  constructor(private opts: { onChange: (u: UsageView) => void; fetch?: () => Promise<RawUsage>; pathToClaude?: string }) {}

  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.lastTry = Date.now();
    this.running = (async () => {
      try {
        const raw = await (this.opts.fetch ?? (() => sdkFetch(this.opts.pathToClaude)))();
        this.last = toView(raw);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn('플랜 사용량 조회 실패', msg);
        this.last = { ...this.last, error: msg.slice(0, 200) };
      } finally {
        this.running = null;
      }
      this.opts.onChange(this.last);
    })();
    return this.running;
  }

  /** 에이전트 스트림에 한도 이벤트가 오면: 마지막 조회 1분 지났을 때만 다시 */
  poke(): void {
    if (Date.now() - this.lastTry >= 60_000) void this.refresh();
  }
}
