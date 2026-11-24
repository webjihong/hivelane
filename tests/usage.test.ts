import { describe, expect, it } from 'vitest';
import { PlanUsage, toView, type RawUsage } from '../server/po/usage.ts';

const raw = (rl: RawUsage['rate_limits'], available = true): RawUsage => ({ subscription_type: 'max', rate_limits_available: available, rate_limits: rl });

describe('플랜 사용량', () => {
  it('5시간·주간은 싣고 쓴 게 없는 모델별 창은 뺀다', () => {
    const v = toView(raw({ five_hour: { utilization: 12.4, resets_at: 'a' }, seven_day: { utilization: 68, resets_at: 'b' }, seven_day_opus: { utilization: 0, resets_at: null }, seven_day_sonnet: null }));
    expect(v.available).toBe(true);
    expect(v.windows.map((w) => [w.label, w.pct])).toEqual([['5시간', 12.4], ['주간', 68]]);
  });
  it('플랜 한도가 없으면(API 키) 숨김', () => {
    expect(toView(raw(null, false)).available).toBe(false);
    expect(toView(raw({ five_hour: null, seven_day: null })).available).toBe(false);
  });
  it('조회 실패는 이전 값을 두고 error 만 채운다 · poke 는 1분 안엔 다시 안 묻는다', async () => {
    let n = 0; let fail = false; const seen: number[] = [];
    const u = new PlanUsage({ onChange: (x) => seen.push(x.windows.length), fetch: async () => { n++; if (fail) throw new Error('끊김'); return raw({ seven_day: { utilization: 50, resets_at: null } }); } });
    await u.refresh();
    expect(u.last.windows[0]!.pct).toBe(50);
    u.poke();
    expect(n).toBe(1);
    fail = true;
    await u.refresh();
    expect(u.last.error).toBe('끊김');
    expect(u.last.windows[0]!.pct).toBe(50);
    expect(seen).toEqual([1, 1]);
  });
});
