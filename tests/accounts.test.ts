import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountManager } from '../server/accounts.ts';
import { codexSandbox, codexUsageView, findDeviceCode } from '../server/agents/codex.ts';
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
    expect(accounts.list().map((a) => a.id)).toEqual(['default', 'codex']);
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

  it('계정이 바뀌었는데 대화 기록 파일을 못 찾으면 세션을 끊는다(예전 세션은 기본 계정 것으로 본다)', () => {
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

  it('계정이 바뀌어도 대화 기록 파일을 새 계정 폴더로 복사해 같은 세션을 이어 쓴다', () => {
    const { store, accounts } = setup();
    const home = accounts.add('개인');
    const work = accounts.add('회사');
    const a = store.insertAgent({ team_id: null, role_key: 'po', role_name: 'PO', model: 'opus', run_mode: 'session', system_prompt: '', allowed_tools: [] });
    expect(accounts.bind(a.id, home.id).changed).toBe(true); // 세션 없음 → 끊을 것도 없음
    store.updateAgent(a.id, { session_id: 'sess-1' });
    const proj = join(home.configDir!, 'projects', '-work-dir');
    mkdirSync(join(proj, 'sess-1', 'subagents'), { recursive: true });
    writeFileSync(join(proj, 'sess-1.jsonl'), '{"type":"user"}\n');
    writeFileSync(join(proj, 'sess-1', 'subagents', 'x.jsonl'), '{}\n');
    const r = accounts.bind(a.id, work.id);
    expect(r).toMatchObject({ reset: false, changed: true });
    expect(store.getAgent(a.id)?.session_id).toBe('sess-1');
    expect(readFileSync(join(work.configDir!, 'projects', '-work-dir', 'sess-1.jsonl'), 'utf8')).toContain('user');
    expect(existsSync(join(work.configDir!, 'projects', '-work-dir', 'sess-1', 'subagents', 'x.jsonl'))).toBe(true);
    expect(accounts.bind(a.id, work.id).changed).toBe(false);
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

describe('사용량 기준 계정 전환', () => {
  function withUsage() {
    const { cfg, store } = testEnv();
    const peaks = new Map<string, number>();
    const notes: string[] = [];
    const mk = (env: Record<string, string>) => {
      const key = env.CLAUDE_CONFIG_DIR ?? 'default';
      return { get last() { const p = peaks.get(key); return { available: true, plan: 'max', windows: p === undefined ? [] : [{ key: 'five_hour', label: '5시간', pct: p, resets_at: null }], takenAt: null, error: null, login: { loggedIn: true, method: 'claude.ai', expiresAt: null, email: null } }; }, refresh: async () => {} } as unknown as PlanUsage;
    };
    const accounts = new AccountManager({ cfg, store, onChange: () => {}, makeUsage: mk, notify: (t) => notes.push(t) });
    const a = accounts.add('주 계정');
    const b = accounts.add('예비');
    store.saveSettings({ defaultAccount: a.id });
    for (const x of accounts.list()) accounts.usage(x.id); // 사용량 객체 준비
    const set = (id: string, p: number) => peaks.set(accounts.get(id)!.configDir!, p);
    return { store, accounts, a, b, set, notes };
  }

  it('끄기: 기준을 넘어도 그대로 · 알림: 한 번만 알리고 그대로, 「전환」을 누르면 바꿔 씀', () => {
    const { store, accounts, a, b, set, notes } = withUsage();
    set(a.id, 95); set(b.id, 10);
    expect(accounts.effective(accounts.resolve(null)).id).toBe(a.id);
    store.saveSettings({ accountSwitch: { mode: 'ask', thresholdPct: 90, order: [] } });
    expect(accounts.effective(accounts.resolve(null)).id).toBe(a.id);
    accounts.effective(accounts.resolve(null));
    expect(notes.filter((n) => n.includes('권합니다'))).toHaveLength(1);
    expect(accounts.switchView().suggestions).toEqual([{ from: a.id, to: b.id, pct: 95 }]);
    accounts.switchNow(a.id);
    expect(accounts.effective(accounts.resolve(null)).id).toBe(b.id);
  });

  it('자동: 기준을 넘으면 다음 계정으로, 원래 계정이 기준 아래로 내려오면 저절로 돌아옴 · 바꿀 계정이 없으면 그대로', () => {
    const { store, accounts, a, b, set } = withUsage();
    store.saveSettings({ accountSwitch: { mode: 'auto', thresholdPct: 80, order: [] } });
    set(a.id, 85); set(b.id, 90);
    expect(accounts.effective(accounts.resolve(null)).id).toBe(a.id); // 예비도 기준 넘음
    set(b.id, 20);
    expect(accounts.effective(accounts.resolve(null)).id).toBe(b.id);
    expect(accounts.switchView().overrides[0]).toMatchObject({ from: a.id, to: b.id, auto: true });
    set(a.id, 5);
    expect(accounts.effective(accounts.resolve(null)).id).toBe(a.id);
    expect(accounts.switchView().overrides).toEqual([]);
  });
});

describe('이 맥 기본 계정 숨기기', () => {
  it('내 Claude 계정이 있으면 숨기고 그 계정을 기본으로 · 내 계정이 모두 로그인 안 됨으로 확인되면 다시 보임', () => {
    const { cfg, store } = testEnv();
    const logged = new Map<string, boolean>();
    const mk = (env: Record<string, string>) => ({ get last() { return { available: false, plan: null, windows: [], takenAt: null, error: null, login: { loggedIn: logged.get(env.CLAUDE_CONFIG_DIR ?? 'default') ?? true, method: null, expiresAt: null, email: null } }; }, refresh: async () => {} }) as unknown as PlanUsage;
    const accounts = new AccountManager({ cfg, store, onChange: () => {}, makeUsage: mk });
    expect(accounts.list().map((a) => a.id)).toContain('default');
    const mine = accounts.add('내 계정');
    accounts.usage(mine.id);
    expect(accounts.list().map((a) => a.id)).not.toContain('default');
    expect(accounts.resolve(null).id).toBe(mine.id);
    expect(accounts.resolve('default').id).toBe(mine.id); // 예전에 이 맥 기본을 고른 역할도 내 계정으로
    expect(accounts.views(() => []).find((v) => v.isDefault)?.id).toBe(mine.id);
    logged.set(mine.configDir!, false);
    expect(accounts.list().map((a) => a.id)).toContain('default');
  });
});

describe('Codex 계정·실행', () => {
  it('Codex 계정은 CODEX_HOME 폴더 · PM·총괄에서 고르면 기본(Claude) 계정 · 독립 세션 팀원만 Codex', () => {
    const { store, accounts } = setup();
    const cx = accounts.add('회사 Codex', 'codex');
    expect(cx.configDir!.endsWith('/codex')).toBe(true);
    expect(accounts.env(cx)).toEqual({ CODEX_HOME: cx.configDir });
    expect(accounts.resolve(cx.id).id).toBe('default');
    expect(accounts.resolve(cx.id, true).id).toBe(cx.id);
    store.saveSettings({ defaultAccount: 'codex' });
    expect(accounts.resolve(null).id).toBe('default'); // 기본 계정은 Claude 만
    expect(() => accounts.remove('codex')).toThrow();
    expect(() => accounts.switchNow('default', cx.id)).toThrow();
  });

  it('사용량·로그인 출력 해석 · 역할 도구 → 샌드박스', () => {
    const v = codexUsageView({ rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1795589246 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: null }, planType: 'plus' } }, { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' } }, null);
    expect(v.windows.map((w) => `${w.label}:${w.pct}`)).toEqual(['5시간:42', '주간:7']);
    expect(v.login).toMatchObject({ loggedIn: true, email: 'a@b.c' });
    expect(codexUsageView(undefined, { account: null }, null).login?.loggedIn).toBe(false);
    expect(findDeviceCode('2. Enter this one-time code \u001b[90m(expires)\u001b[0m\n   \u001b[94m1BNE-8VFV2\u001b[0m')).toBe('1BNE-8VFV2');
    expect(codexSandbox('read')).toBe('read-only');
    expect(codexSandbox('verify')).toBe('workspace-write');
    expect(codexSandbox('write')).toBe('workspace-write');
  });

  it('PM 이 맡긴 독립 세션 팀원은 Codex 로 돈다(샌드박스용 역할 도구 전달) · 이어 쓰기 실패하면 새 대화로 한 번 다시', async () => {
    const { cfg, store, accounts } = setup();
    const specs: TurnSpec[] = [];
    let devCalls = 0;
    const runner: TurnRunner = { async runTurn(spec) {
      specs.push(spec);
      const base = { ok: true, subtype: 'success', text: '대기', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10 };
      if (spec.agent.role_key === 'pm') {
        const t = spec.toolsImpl as { delegate(k: string, i: string): Promise<string>; report(s: string, x: string): string };
        await t.delegate('dev', '고쳐');
        await t.delegate('dev', '또 고쳐');
        return base;
      }
      devCalls++;
      if (devCalls === 2) return { ...base, ok: false, subtype: 'exception', error: 'thread not found', sessionId: spec.resume ?? null };
      return { ...base, text: '고침', sessionId: 'cx-thread' };
    } };
    const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier: new NullNotifier(), accounts });
    const st = orch.createStanding({ name: '혼합', project_id: null, template_id: null, brief: 'b', roles: [
      { key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm', account: 'codex' },
      { key: 'dev', name: '개발', model: 'opus', mode: 'session', tools: 'write', account: 'codex' },
    ] });
    orch.message(st.id, '확인해', 'user');
    await until(() => specs.length >= 4);
    await orch.idle();
    expect(specs[0]!.provider ?? 'claude').toBe('claude'); // PM 은 Codex 를 골라도 Claude
    const dev = specs.filter((s) => s.agent.role_key === 'dev');
    expect(dev.map((s) => `${s.provider}:${s.toolPreset}:${s.resume ?? '-'}`)).toEqual(['codex:write:-', 'codex:write:cx-thread', 'codex:write:-']);
  });
});
