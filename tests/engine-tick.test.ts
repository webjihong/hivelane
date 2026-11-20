import { describe, expect, it } from 'vitest';
import type { TurnHandle, TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { Engine } from '../server/po/engine.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY } from '../server/store.ts';
import type { TeamTools } from '../server/teams/tools.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';
import { makeRepo, testEnv } from './helpers.ts';

describe('엔진 틱(가짜 측정값)', () => {
  it('초록이면 대기 팀 시작, 빨강이 이어지면 멈춤, 점검 실패면 직속 팀을 깨움', async () => {
    const { cfg, store } = testEnv();
    const repo = makeRepo();
    const p = store.insertProject({ name: 'demo', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: DEFAULT_HEAVY, blocked_patterns: DEFAULT_BLOCKED, memory_paths: [], default_template_id: 'tpl-dev' });
    const prompts: string[] = [];
    const runner: TurnRunner = {
      async runTurn(spec: TurnSpec, h: TurnHandle): Promise<TurnResult> {
        prompts.push(`${spec.team?.lifetime}:${spec.prompt.slice(0, 40)}`);
        if (spec.team?.lifetime === 'task') { while (!h.pauseRequested) await sleep(10); h.interrupted = true; }
        else (spec.toolsImpl as TeamTools).report('done', '확인함');
        return { ok: !h.interrupted, subtype: 'success', text: '', costUsd: 0, sessionId: 's1', interrupted: h.interrupted, error: null, contextTokens: 10 };
      },
    };
    const slots = new HeavySlots(2);
    const orch = new Orchestrator({ cfg, store, runner, slots, notifier: new NullNotifier() });
    let cpu = 20;
    const engine = new Engine({ store, orch, slots, sampler: { cpu: () => cpu, mem: async () => 40, procs: async () => [] } });
    store.saveSettings({ engine: { ...store.getSettings().engine, sustainSec: 5, pauseEverySec: 5 } });

    const prop = store.insertProposal({ project_id: p.id, title: 'x', instruction: 'x', brief: 'x', template_id: 'tpl-dev', roles: store.getTemplate('tpl-dev')!.roles, priority: 'low', budget_usd: 1, note: '' });
    const team = orch.createFromProposal(prop.id);
    const t0 = 1_000_000;
    await engine.tick(t0);
    for (let i = 0; i < 100 && !orch.isRunning(team.id); i++) await sleep(20);
    expect(store.getTeam(team.id)!.state).toBe('running');
    expect(engine.last.zone).toBe('green');

    cpu = 95;
    await engine.tick(t0 + 1000);
    expect(store.getTeam(team.id)!.state).toBe('running'); // 아직 지속 시간 전
    await engine.tick(t0 + 7000);
    expect(engine.last.zone).toBe('red');
    expect(slots.stats.capacity).toBe(0);
    await orch.idle();
    expect(store.getTeam(team.id)).toMatchObject({ state: 'paused', pause_kind: 'engine-soft' });

    const st = orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b', check_command: 'echo boom >&2; exit 3', check_interval_sec: 60 });
    await engine.tick(t0 + 8000);
    for (let i = 0; i < 200 && !prompts.some((x) => x.startsWith('standing:[점검 이상]')); i++) await sleep(20);
    await orch.idle();
    expect(store.getTeam(st.id)).toMatchObject({ state: 'idle', last_check_ok: 0 });
    expect(store.teamDetail(st.id)!.messages.some((m) => m.body.includes('boom'))).toBe(true);
  });
});
