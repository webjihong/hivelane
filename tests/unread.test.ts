import { describe, expect, it } from 'vitest';
import { NullNotifier } from '../server/notify/index.ts';
import { Engine } from '../server/po/engine.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';
import { testEnv } from './helpers.ts';

const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };

function setup() {
  const { cfg, store } = testEnv();
  const runner: TurnRunner = { async runTurn(spec) { (spec.toolsImpl as { report: (s: string, t: string) => void }).report('done', '**결론: 정상**'); return { ok: true, subtype: 'success', text: '', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10 }; } };
  const notifier = new NullNotifier();
  const slots = new HeavySlots(2);
  const orch = new Orchestrator({ cfg, store, runner, slots, notifier });
  const engine = new Engine({ store, orch, slots, notifier, sampler: { cpu: () => 10, mem: async () => 30, procs: async () => [] } });
  return { store, orch, engine, notifier };
}

describe('읽지 않은 답변·알림', () => {
  it('직속 팀 답이 오면 알림 + 안 읽음 1, 열면 0', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '궁금증해결', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '확인해', 'user');
    await until(() => env.store.getTeam(st.id)!.state === 'idle' && env.store.teamUnread(st.id) > 0);
    expect(env.notifier.sent.map((n) => n.title)).toContain('궁금증해결 답변');
    expect(env.store.teamUnread(st.id)).toBe(1);
    env.store.markTeamSeen(st.id);
    expect(env.store.teamUnread(st.id)).toBe(0);
  });
  it('안 읽은 답이 남아 있으면 간격마다 다시 알림, 읽으면 멈춤', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '확인해', 'user');
    await until(() => env.store.teamUnread(st.id) > 0);
    await env.orch.idle();
    const base = Date.now();
    const reminders = () => env.notifier.sent.filter((n) => n.tag === 'unread-remind').length;
    await env.engine.tick(base + 60_000);
    expect(reminders()).toBe(0);
    await env.engine.tick(base + 31 * 60_000);
    expect(reminders()).toBe(1);
    expect(env.notifier.sent.at(-1)!.title).toBe('읽지 않은 답변 1건');
    await env.engine.tick(base + 40 * 60_000);
    expect(reminders()).toBe(1);
    await env.engine.tick(base + 62 * 60_000);
    expect(reminders()).toBe(2);
    env.store.markTeamSeen(st.id);
    await env.engine.tick(base + 100 * 60_000);
    expect(reminders()).toBe(2);
  });
  it('처음 켤 때 옛 기록은 읽은 것으로(알림 폭탄 방지)', () => {
    const { store } = testEnv();
    store.addChat({ role: 'po', body: '옛 답' });
    store.initSeenBaseline();
    expect(store.poUnread()).toBe(0);
    store.addChat({ role: 'po', body: '새 답' });
    expect(store.poUnread()).toBe(1);
    store.initSeenBaseline();
    expect(store.poUnread()).toBe(1);
  });
});

describe('슬랙 형식', () => {
  it('**굵게** → *굵게*, 제목 → 굵게, 첨부 이미지 표시', async () => {
    const { toSlack } = await import('../server/notify/index.ts');
    expect(toSlack('**결론: 끝**\n## 근거\n- `a.ts` 수정\n![캡처](/api/uploads/u-abcdefabcdef.png)')).toBe('*결론: 끝*\n*근거*\n- `a.ts` 수정\n[이미지 캡처]');
  });
});
