import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AccountManager } from '../server/accounts.ts';
import type { TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { HeavySlots } from '../server/po/slots.ts';
import type { PlanUsage } from '../server/po/usage.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';
import { testEnv } from './helpers.ts';

const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };
const fakeUsage = () => ({ last: { available: false, plan: null, windows: [], takenAt: null, error: null }, refresh: async () => {} }) as unknown as PlanUsage;

function setup() {
  const { cfg, store } = testEnv();
  const accounts = new AccountManager({ cfg, store, onChange: () => {}, makeUsage: fakeUsage });
  return { cfg, store, accounts };
}

describe('AI 계정 여러 개', () => {
  it('기본 계정은 늘 있고 지울 수 없다 · 추가하면 계정마다 로그인 폴더 · 지우면 폴더도 지우고 기본으로 돌아간다', () => {
    const { store, accounts } = setup();
    expect(accounts.list().map((a) => a.id)).toEqual(['default']);
    expect(accounts.env(accounts.resolve(null))).toEqual({});
    expect(() => accounts.remove('default')).toThrow();

    const work = accounts.add('회사 계정');
    expect(work.configDir && existsSync(work.configDir)).toBeTruthy();
    expect(accounts.env(work)).toEqual({ CLAUDE_CONFIG_DIR: work.configDir });
    store.saveSettings({ defaultAccount: work.id, poAccount: work.id });
    expect(accounts.resolve(null).id).toBe(work.id);
    expect(accounts.resolve('없는-id').id).toBe(work.id);

    accounts.remove(work.id);
    expect(existsSync(work.configDir!)).toBe(false);
    expect(store.getSettings()).toMatchObject({ defaultAccount: 'default', poAccount: null });
    expect(accounts.resolve(work.id).id).toBe('default');
  });

  it('에이전트 계정이 바뀌면 세션을 끊는다(예전 세션은 기본 계정 것으로 본다)', () => {
    const { store, accounts } = setup();
    const a = store.insertAgent({ team_id: null, role_key: 'po', role_name: 'PO', model: 'opus', run_mode: 'session', system_prompt: '', allowed_tools: [] });
    store.updateAgent(a.id, { session_id: 's-old' });
    expect(accounts.bind(a.id, null).reset).toBe(false);
    expect(store.getAgent(a.id)?.session_id).toBe('s-old');
    const work = accounts.add('회사');
    const r = accounts.bind(a.id, work.id);
    expect(r.reset).toBe(true);
    expect(r.env.CLAUDE_CONFIG_DIR).toBe(work.configDir);
    expect(store.getAgent(a.id)?.session_id ?? null).toBeNull();
    expect(accounts.bind(a.id, work.id).reset).toBe(false);
  });

  it('팀 PM 은 역할에 고른 계정의 로그인 폴더로 돈다', async () => {
    const { cfg, store, accounts } = setup();
    const work = accounts.add('회사');
    const specs: TurnSpec[] = [];
    const runner: TurnRunner = { async runTurn(spec) { specs.push(spec); return { ok: true, subtype: 'success', text: '대기', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10 }; } };
    const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier: new NullNotifier(), accounts });
    const st = orch.createStanding({ name: '점검', project_id: null, template_id: null, brief: 'b', roles: [{ key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm', account: work.id }] });
    orch.message(st.id, '확인해', 'user');
    await until(() => specs.length > 0);
    await orch.idle();
    expect(specs[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: work.configDir });
  });
});
