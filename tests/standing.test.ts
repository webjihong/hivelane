import { describe, expect, it } from 'vitest';
import type { TurnHandle, TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { PoAgent } from '../server/po/agent.ts';
import { Engine } from '../server/po/engine.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';
import { testEnv } from './helpers.ts';

const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };

function setup(teamTurn: (spec: TurnSpec, h: TurnHandle) => Partial<TurnResult> = () => ({})) {
  const { cfg, store } = testEnv();
  const prompts: string[] = [];
  let poTools: ReturnType<PoAgent['tools']> | null = null;
  let poScript: (t: ReturnType<PoAgent['tools']>) => Promise<string> = async () => '-';
  const runner: TurnRunner = {
    async runTurn(spec, h) {
      if (spec.label === 'PO') { poTools = spec.toolsImpl as ReturnType<PoAgent['tools']>; const text = await poScript(poTools); return { ok: true, subtype: 'success', text, costUsd: 0, sessionId: 'po', interrupted: false, error: null, contextTokens: 10 }; }
      prompts.push(spec.prompt);
      return { ok: true, subtype: 'success', text: '대기', costUsd: 0, sessionId: 's', interrupted: h.interrupted, error: null, contextTokens: 10, ...teamTurn(spec, h) };
    },
  };
  const slots = new HeavySlots(2);
  const notifier = new NullNotifier();
  const orch = new Orchestrator({ cfg, store, runner, slots, notifier });
  const po = new PoAgent({ cfg, store, runner, orch, search: new Search(store), notifier });
  const engine = new Engine({ store, orch, slots, sampler: { cpu: () => 10, mem: async () => 30, procs: async () => [] } });
  const poTurn = async (script: typeof poScript, user: string | null) => {
    poScript = script;
    const before = store.chat(500).length;
    if (user) po.say(user); else store.addPoEvent('report', null, {});
    await until(() => !po.busy && store.chat(500).length > before + (user ? 1 : 0), 6000);
    await sleep(30);
  };
  return { store, orch, po, engine, prompts, poTurn };
}

describe('직속 팀: PO 생성·종료와 유지', () => {
  it('사용자가 시킨 턴에서만 PO 가 직속 팀을 만들고 끝낸다', async () => {
    const env = setup();
    const results: string[] = [];
    const mk = async (t: ReturnType<PoAgent['tools']>) => { results.push(t.createStanding({ name: '서버 감시팀', project: null, template_id: 'tpl-ops', brief: '서버 상태를 본다' })); return '만들었다'; };
    // 사건 턴(사용자 메시지 없음)에서는 거절
    await env.poTurn(mk, null);
    expect(results[0]).toMatch(/^거절/);
    expect(env.store.listTeams("lifetime = 'standing'")).toHaveLength(0);
    // 사용자 지시 턴에서는 바로 생성(승인 카드 없음)
    await env.poTurn(mk, '서버 감시 직속팀 만들어줘');
    const st = env.store.listTeams("lifetime = 'standing'");
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ name: '서버 감시팀', managed_by: 'user', state: 'idle' });
    const id = st[0]!.id;
    // 사건 턴의 종료 시도는 거절
    await env.poTurn(async (t) => { results.push(await t.endStanding(id, '한가함')); return '안 끝냄'; }, null);
    expect(results.at(-1)).toMatch(/^거절/);
    expect(env.store.getTeam(id)!.state).not.toBe('archived');
    // 사용자가 끝내라고 한 턴에서는 종료
    await env.poTurn(async (t) => { results.push(await t.endStanding(id, '사용자가 감시팀 그만')); return '끝냈다'; }, '감시팀 이제 끝내');
    expect(env.store.getTeam(id)!.state).toBe('archived');
  });

  it('PO 가 전한 지시로 직속 팀이 바로 깨어나 처리한다', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    expect(env.orch.message(st.id, '디스크 확인해', 'po')).toBe('delivered');
    await until(() => env.prompts.some((p) => p.includes('PO 지시: 디스크 확인해')));
    await env.orch.idle();
    expect(env.store.getTeam(st.id)!.state).toBe('idle');
  });

  it('오래된 팀도 턴마다 현재 지시문(보고 형식 규칙)으로 갱신된다', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    for (const a of env.store.teamAgents(st.id)) env.store.updateAgent(a.id, { system_prompt: '옛 지시문' });
    env.orch.message(st.id, '확인해', 'user');
    await until(() => env.prompts.length > 0);
    await env.orch.idle();
    for (const a of env.store.teamAgents(st.id)) expect(a.system_prompt).toContain('**결론**');
  });

  it('장애로 down 된 직속 팀은 엔진이 간격을 두고 계속 되살린다(끝내지 않음)', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.store.updateTeam(st.id, { state: 'down', error: 'x' });
    const t0 = 10_000_000;
    await env.engine.tick(t0);
    expect(env.store.getTeam(st.id)!.state).toBe('down');
    await env.engine.tick(t0 + 60_000);
    expect(env.store.getTeam(st.id)!.state).toBe('down');
    await env.engine.tick(t0 + 121_000);
    await until(() => env.prompts.some((p) => p.includes('자동으로 다시 시작')));
    await env.orch.idle();
    expect(env.store.getTeam(st.id)!.state).toBe('idle');
    // 다시 장애 → 다음 시도는 더 늦게(5분)
    env.store.updateTeam(st.id, { state: 'down' });
    const n = env.prompts.length;
    await env.engine.tick(t0 + 122_000);
    await env.engine.tick(t0 + 122_000 + 121_000);
    expect(env.prompts.length).toBe(n);
  });
});
