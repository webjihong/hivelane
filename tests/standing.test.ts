import { describe, expect, it } from 'vitest';
import type { TurnHandle, TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { PoAgent } from '../server/po/agent.ts';
import { Engine } from '../server/po/engine.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, testEnv } from './helpers.ts';

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
  return { cfg, store, orch, po, engine, prompts, poTurn };
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

  it('사용자가 직접 지시한 일의 보고는 사용자에게, PO 가 전한 일은 PO 에게', async () => {
    const env = setup((spec) => { (spec.toolsImpl as { report: (s: string, t: string) => void }).report('done', '**결론: 끝**'); return {}; });
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '확인해', 'user');
    await until(() => env.prompts.length > 0); await env.orch.idle();
    const rep = () => env.store.db.prepare("SELECT to_label FROM messages WHERE team_id = ? AND kind = 'report' AND from_label = 'PM' ORDER BY id DESC LIMIT 1").get(st.id) as { to_label: string };
    expect(rep().to_label).toBe('사용자');
    env.orch.message(st.id, '디스크 봐', 'po');
    await until(() => env.prompts.length > 1); await env.orch.idle();
    expect(rep().to_label).toBe('PO');
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

describe('작업 환경: 내 Claude Code 와 동일', () => {
  it('사용자 설정·역할 제한 해제·메모리 쓰기, 운영 명령은 승인 요청 → 승인 → 한 번만 실행', async () => {
    const { cfg, store } = (await import('./helpers.ts')).testEnv();
    const { Orchestrator } = await import('../server/teams/orchestrator.ts');
    const { HeavySlots } = await import('../server/po/slots.ts');
    const { NullNotifier } = await import('../server/notify/index.ts');
    const { DEFAULT_BLOCKED } = await import('../server/store.ts');
    const { makeRepo } = await import('./helpers.ts');
    const project = store.insertProject({ name: 'hv', path: makeRepo(), base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: DEFAULT_BLOCKED, memory_paths: ['/mem/hv'], default_template_id: null });
    const specs: TurnSpec[] = [];
    let step = 0;
    const runner: TurnRunner = { async runTurn(spec) {
      specs.push(spec);
      const t = spec.toolsImpl as { requestApproval: (c: string, r: string) => string };
      if (step++ === 0) t.requestApproval('npm run db:prod:sync', '스키마 반영');
      return { ok: true, subtype: 'success', text: '', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10 };
    } };
    const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier: new NullNotifier() });
    const st = orch.createStanding({ name: 'hiveline', project_id: project.id, template_id: 'tpl-ops', brief: 'b' });
    store.updateTeam(st.id, { env_mode: 'mine' });
    orch.message(st.id, '운영 DB 반영해', 'user');
    await until(() => !!store.getTeam(st.id)!.question);
    await orch.idle();
    const s0 = specs[0]!;
    expect(s0.envMine).toBe(true);
    expect(s0.writableRoots).toContain('/mem/hv');
    expect(s0.blockedPatterns).not.toContain('db:prod');
    expect(s0.approval!.patterns).toContain('db:prod');
    expect(s0.allowedTools).toContain('mcp__hivelane__request_approval');
    expect(s0.approval!.take('npm run db:prod:sync')).toBe(false);
    expect(store.getTeam(st.id)!.question).toContain('"kind":"approval"');
    orch.message(st.id, '승인', 'user');
    await until(() => specs.length > 1);
    await orch.idle();
    expect(specs[1]!.prompt).toContain('승인됨');
    expect(specs[1]!.approval!.take('npm run db:prod:sync')).toBe(true);
    expect(specs[1]!.approval!.take('npm run db:prod:sync')).toBe(false);
  });
  it('격리 팀은 예전대로(운영 명령은 막힘, 승인 도구 없음)', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '확인', 'user');
    await until(() => env.prompts.length > 0);
    await env.orch.idle();
    expect(env.store.getTeam(st.id)!.env_mode).toBe('isolated');
  });
});

describe('PO git 정리(worktree·로컬 브랜치)', () => {
  it('최근·잠김·쓰는 중은 남김 · 합쳐진 것만 바로 · 변경/고유 커밋은 동의 후 · 사용자 지시 턴만', async () => {
    const env = setup();
    const repo = makeRepo();
    env.store.insertProject({ name: 'app', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
    const old = new Date(Date.now() - 2 * 86_400_000);
    const age = (wt: string, files: string[] = []) => {
      const gd = execFileSync('git', ['-C', wt, 'rev-parse', '--absolute-git-dir']).toString().trim();
      for (const f of [join(gd, 'index'), join(gd, 'HEAD'), join(gd, 'logs', 'HEAD'), ...files.map((x) => join(wt, x))]) if (existsSync(f)) utimesSync(f, old, old);
    };
    const W = (n: string) => join(env.cfg.worktreesDir, 'app', n);
    // 합쳐진 브랜치 + 변경 없는 오래된 worktree → 정리 가능
    g('worktree', 'add', '-b', 'feat/done', W('done'), 'main'); age(W('done'));
    // 변경 있는 오래된 worktree → 확인 필요
    g('worktree', 'add', '-b', 'feat/dirty', W('dirty'), 'main'); writeFileSync(join(W('dirty'), 'README.md'), '# 바뀜\n'); age(W('dirty'), ['README.md']);
    // 방금 만든 worktree → 남김
    g('worktree', 'add', '-b', 'feat/recent', W('recent'), 'main');
    // 잠긴 worktree → 남김
    g('worktree', 'add', '-b', 'feat/locked', W('locked'), 'main'); age(W('locked')); g('worktree', 'lock', W('locked'));
    // 어디에도 없는 커밋이 있는 브랜치(worktree 없음) → 확인 필요
    g('branch', 'feat/solo', 'main'); g('worktree', 'add', W('tmp'), 'feat/solo'); writeFileSync(join(W('tmp'), 'x.txt'), 'x'); execFileSync('git', ['-C', W('tmp'), 'add', '.']); execFileSync('git', ['-C', W('tmp'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'solo']); g('worktree', 'remove', W('tmp'));

    const out: string[] = [];
    await env.poTurn(async (t) => { out.push(await t.scanGitCleanup('app')); out.push(await t.gitCleanup({ project: 'app', ids: [`wt:${W('done')}`], reason: '정리' })); return '살펴봄'; }, null);
    const scan = out[0]!;
    const line = (k: string) => scan.split('\n').find((l) => l.includes(k)) ?? '';
    expect(line('/done ')).toContain('[정리 가능]');
    expect(line('/dirty ')).toContain('[확인 필요]');
    expect(line('/recent ')).toContain('[남김]');
    expect(line('/locked ')).toContain('[남김]');
    expect(line('br:feat/solo')).toContain('[확인 필요]');
    expect(line('br:main')).toContain('[남김]');
    expect(out[1]).toMatch(/거절/);

    await env.poTurn(async (t) => { out.push(await t.gitCleanup({ project: 'app', ids: [`wt:${W('done')}`, 'br:feat/done', `wt:${W('dirty')}`, `wt:${W('recent')}`, 'br:feat/solo', 'br:main'], reason: '정리해' })); return '정리'; }, '정리 가능한 거 지워');
    const r = out[2]!;
    expect(r).toMatch(/지움 worktree .*\/app\/done/);
    expect(r).toContain('지움 브랜치 feat/done');
    expect(r).toMatch(/멈춤 .*dirty/);
    expect(r).toMatch(/남김 .*recent/);
    expect(r).toMatch(/멈춤 feat\/solo/);
    expect(r).toMatch(/남김 main/);
    expect(existsSync(W('done'))).toBe(false);
    expect(existsSync(W('dirty'))).toBe(true);

    await env.poTurn(async (t) => { out.push(await t.gitCleanup({ project: 'app', ids: [`wt:${W('dirty')}`, 'br:feat/solo'], discard_changes: true, reason: '버려도 됨' })); return '정리'; }, '그것도 버려도 돼');
    expect(existsSync(W('dirty'))).toBe(false);
    expect(g('branch', '--list', 'feat/solo')).toBe('');
    expect(existsSync(W('locked'))).toBe(true);
  });
});
