import { GitCleanWatcher } from '../server/projects/cleanwatch.ts';
import { readPatch } from '../server/projects/archive.ts';
import { snapshotTeams } from '../server/http/app.ts';
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
    await until(() => env.prompts.some((p) => p.includes('총괄 지시: 디스크 확인해')));
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
  it('없는 도구는 임시 권한 요청 → 승인하면 팀 전체에 부여 → 지시가 끝나면 회수 · 거절하면 그대로', async () => {
    const specs: TurnSpec[] = [];
    let ask = true;
    const env = setup((spec) => {
      specs.push(spec);
      const t = spec.toolsImpl as { requestTools: (x: string[], r: string) => string };
      if (ask) { ask = false; t.requestTools(['Bash', 'Edit'], '외부 DB 조회'); }
      return {};
    });
    const st = env.orch.createStanding({ name: '조사', project_id: null, template_id: 'tpl-research', brief: 'b' });
    env.orch.message(st.id, '실측해', 'user');
    await until(() => !!env.store.getTeam(st.id)!.question);
    await env.orch.idle();
    const s0 = specs[0]!;
    expect(s0.allowedTools).not.toContain('Bash');
    expect(s0.allowedTools).toContain('mcp__hivelane__request_tools');
    const q = JSON.parse(env.store.getTeam(st.id)!.question!);
    expect(q).toMatchObject({ kind: 'tools', tools: ['Bash', 'Edit'], options: ['승인', '거절'] });
    env.orch.message(st.id, '승인', 'user');
    await until(() => specs.length > 1);
    await env.orch.idle();
    const s1 = specs[1]!;
    expect(s1.prompt).toContain('승인됨');
    expect(s1.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'MultiEdit']));
    expect(s1.subagents!.explore!.tools).toContain('Bash');
    // 지시가 끝나면(idle) 회수
    expect(env.orch.grants(st.id)).toEqual([]);
    const acts = (env.store.db.prepare('SELECT action FROM po_decisions WHERE team_id = ?').all(st.id) as { action: string }[]).map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['grant', 'revoke']));
    // 거절하면 도구 없음
    ask = true;
    env.orch.message(st.id, '다시', 'user');
    await until(() => !!env.store.getTeam(st.id)!.question);
    await env.orch.idle();
    env.orch.message(st.id, '거절', 'user');
    await until(() => specs.length > 3);
    await env.orch.idle();
    expect(specs[3]!.prompt).toContain('거절됨');
    expect(specs[3]!.allowedTools).not.toContain('Bash');
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

describe('화면 git 정리(사이드바 버튼)', () => {
  it('저장소를 살펴 수를 세고, 고른 것만 지우며 남김·확인 필요는 동의 없이 안 지운다', async () => {
    const env = setup();
    const repo = makeRepo();
    env.store.insertProject({ name: 'app', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
    const old = new Date(Date.now() - 2 * 86_400_000);
    const W = (n: string) => join(env.cfg.worktreesDir, 'app', n);
    const age = (wt: string, files: string[] = []) => {
      const gd = execFileSync('git', ['-C', wt, 'rev-parse', '--absolute-git-dir']).toString().trim();
      for (const f of [join(gd, 'index'), join(gd, 'HEAD'), join(gd, 'logs', 'HEAD'), ...files.map((x) => join(wt, x))]) if (existsSync(f)) utimesSync(f, old, old);
    };
    g('worktree', 'add', '-b', 'feat/done', W('done'), 'main'); age(W('done'));
    g('worktree', 'add', '-b', 'feat/dirty', W('dirty'), 'main'); writeFileSync(join(W('dirty'), 'README.md'), '# 바뀜\n'); age(W('dirty'), ['README.md']);
    g('worktree', 'add', '-b', 'feat/recent', W('recent'), 'main');

    let changes = 0;
    const w = new GitCleanWatcher({ cfg: env.cfg, store: env.store, orch: env.orch, onChange: () => { changes++; } });
    await w.refresh();
    expect(changes).toBeGreaterThan(0);
    const items = w.views[0]!.items;
    const v = (label: RegExp) => items.find((i) => label.test(i.label))?.verdict;
    expect(v(/\/app\/done$/)).toBe('remove');
    expect(v(/\/app\/dirty$/)).toBe('ask');
    expect(v(/\/app\/recent$/)).toBe('keep');
    expect(w.summary.remove).toBeGreaterThanOrEqual(1);
    expect(w.summary.ask).toBe(1);

    const id = (re: RegExp) => items.find((i) => re.test(i.label))!.id;
    const pid = env.store.listProjects()[0]!.id;
    const lines = await w.apply(pid, [id(/\/app\/done$/), 'br:feat/done', id(/\/app\/dirty$/), id(/\/app\/recent$/)], false);
    expect(lines.join('\n')).toMatch(/지움 worktree .*\/app\/done/);
    expect(lines).toContain('지움 브랜치 feat/done');
    expect(lines.join('\n')).toMatch(/멈춤 .*dirty/);
    expect(lines.join('\n')).toMatch(/남김 .*recent/);
    expect(existsSync(W('dirty'))).toBe(true);
    expect(existsSync(W('recent'))).toBe(true);
    expect(w.views[0]!.items.some((i) => /\/app\/done$/.test(i.label))).toBe(false);
    expect(env.store.chat(50).some((c) => c.body.startsWith('git 정리(화면) · app'))).toBe(true);
  });
  it('끝난 팀 버튼: 깨끗하면 바로, 변경이 있으면 동의 후 · 브랜치는 남김 · 돌던 팀은 거절', async () => {
    const env = setup();
    const repo = makeRepo();
    const p = env.store.insertProject({ name: 'app2', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
    const W = (n: string) => join(env.cfg.worktreesDir, 'app2', n);
    g('worktree', 'add', '-b', 'hivelane/a', W('a'), 'main');
    g('worktree', 'add', '-b', 'hivelane/b', W('b'), 'main'); writeFileSync(join(W('b'), 'README.md'), '# 바뀜\n');
    const ta = env.store.insertTeam({ name: '팀A', project_id: p.id, worktree_path: W('a'), branch: 'hivelane/a', state: 'done' });
    const tb = env.store.insertTeam({ name: '팀B', project_id: p.id, worktree_path: W('b'), branch: 'hivelane/b', state: 'failed' });
    const tc = env.store.insertTeam({ name: '팀C', project_id: p.id, worktree_path: W('a'), branch: 'hivelane/a', state: 'running' });
    const w = new GitCleanWatcher({ cfg: env.cfg, store: env.store, orch: env.orch, onChange: () => {} });

    expect((await w.cleanTeam(tc.id, false)).result).toBe('blocked');
    // 방금 끝난(최근) 팀이어도 콕 집어 누르면 지운다
    expect((await w.cleanTeam(ta.id, false)).result).toBe('done');
    expect(existsSync(W('a'))).toBe(false);
    expect(g('branch', '--list', 'hivelane/a')).toContain('hivelane/a');
    expect(env.store.getTeam(ta.id)!.state).toBe('archived');

    const r1 = await w.cleanTeam(tb.id, false);
    expect(r1.result).toBe('dirty');
    expect(r1.dirty).toContain('README.md');
    expect(existsSync(W('b'))).toBe(true);
    expect((await w.cleanTeam(tb.id, true)).result).toBe('done');
    expect(existsSync(W('b'))).toBe(false);
  });
  it('정리 때 변경을 패치로 남기고 기록 · 7일 지난 끝난 팀은 자동 정리 · 스냅샷은 최근 끝난 팀만', async () => {
    const env = setup();
    const repo = makeRepo();
    const p = env.store.insertProject({ name: 'app3', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
    const base = g('rev-parse', 'main').trim();
    const W = (n: string) => join(env.cfg.worktreesDir, 'app3', n);
    g('worktree', 'add', '-b', 'hivelane/x', W('x'), 'main');
    writeFileSync(join(W('x'), 'README.md'), '# 팀이 고침\n'); writeFileSync(join(W('x'), 'new.txt'), '새 파일\n');
    g('worktree', 'add', '-b', 'hivelane/old', W('old'), 'main'); writeFileSync(join(W('old'), 'old.txt'), '오래됨\n');
    g('worktree', 'add', '-b', 'hivelane/fresh', W('fresh'), 'main');
    const tx = env.store.insertTeam({ name: '팀X', project_id: p.id, worktree_path: W('x'), branch: 'hivelane/x', base_sha: base, state: 'done' });
    const eightDays = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const told = env.store.insertTeam({ name: '오래된팀', project_id: p.id, worktree_path: W('old'), branch: 'hivelane/old', base_sha: base, state: 'done' });
    env.store.updateTeam(told.id, { finished_at: eightDays });
    const tfresh = env.store.insertTeam({ name: '새팀', project_id: p.id, worktree_path: W('fresh'), branch: 'hivelane/fresh', base_sha: base, state: 'done' });
    env.store.updateTeam(tfresh.id, { finished_at: new Date().toISOString() });
    const w = new GitCleanWatcher({ cfg: env.cfg, store: env.store, orch: env.orch, onChange: () => {} });

    // 팀 버튼: 변경 버림 동의 → 패치로 남음
    expect((await w.cleanTeam(tx.id, true)).result).toBe('done');
    const pth = env.store.teamPatch(tx.id)!;
    expect(pth).toBeTruthy();
    const patch = readPatch(pth);
    expect(patch).toContain('# 팀이 고침');
    expect(patch).toContain('new.txt');
    expect(readPatch(pth, 'new.txt')).not.toContain('README.md');
    const log = env.store.cleanupLog({ teamId: tx.id });
    expect(log.total).toBe(1);
    expect(log.items[0]).toMatchObject({ kind: 'worktree', by: '팀 버튼', discarded: true, patch: true, patch_files: 2 });

    // 자동 정리: 8일 지난 팀만
    const done = await w.autoClean();
    expect(done).toEqual(['오래된팀']);
    expect(existsSync(W('old'))).toBe(false);
    expect(existsSync(W('fresh'))).toBe(true);
    expect(readPatch(env.store.teamPatch(told.id)!)).toContain('오래됨');
    expect(env.store.cleanupLog({ teamId: told.id }).items[0]!.by).toBe('자동');
    env.store.saveSettings({ autoCleanDays: 0 });
    env.store.updateTeam(tfresh.id, { finished_at: eightDays });
    expect(await w.autoClean()).toEqual([]);

    // 끝난 팀 목록·수
    const fin = env.store.finishedTeams({ state: 'archived' });
    expect(fin.items.map((t) => t.name).sort()).toEqual(['오래된팀', '팀X']);
    expect(fin.items.every((t) => t.patch && !t.worktree)).toBe(true);
    expect(env.store.finishedTeams({ q: '새팀' }).total).toBe(1);
    expect(env.store.finishedCount()).toMatchObject({ archived: 2 });
  });

  it('스냅샷: 일하는 팀 전부 + 끝난 팀은 7일 안 또는 최근 20개', () => {
    const now = Date.now();
    const old = (i: number) => ({ id: `o${i}`, lifetime: 'task', state: 'done', finished_at: new Date(now - (10 + i) * 86_400_000).toISOString(), updated_at: '' });
    const all = [...Array.from({ length: 30 }, (_, i) => old(i)), { id: 'r', lifetime: 'task', state: 'running', finished_at: null, updated_at: new Date(now).toISOString() }, { id: 's', lifetime: 'standing', state: 'idle', finished_at: null, updated_at: '' }];
    const got = snapshotTeams(all, now).map((t) => t.id);
    expect(got).toContain('r'); expect(got).toContain('s');
    expect(got.filter((x) => x.startsWith('o'))).toHaveLength(20);
    expect(got).toContain('o0'); expect(got).not.toContain('o29');
    const recent = [...all, ...Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, lifetime: 'task', state: 'failed', finished_at: new Date(now - i * 3_600_000).toISOString(), updated_at: '' }))];
    expect(snapshotTeams(recent, now).filter((t) => t.id.startsWith('n'))).toHaveLength(25);
  });
});

describe('직속 팀 수정: 프로젝트·템플릿 바꾸기', () => {
  const proj = (store: ReturnType<typeof testEnv>['store'], name: string) => store.insertProject({ name, path: makeRepo(), base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [`/mem/${name}`], default_template_id: null });
  const decisions = (store: ReturnType<typeof testEnv>['store'], id: string) => (store.db.prepare('SELECT reason FROM po_decisions WHERE team_id = ? ORDER BY id').all(id) as { reason: string }[]).map((r) => r.reason);

  it('프로젝트를 바꾸면 이전 worktree 변경을 패치로 보관·제거하고, 작업 폴더·세션을 비운 뒤 다음 지시에 새 프로젝트로 만든다', async () => {
    const env = setup();
    const a = proj(env.store, 'alpha');
    const b = proj(env.store, 'beta');
    const st = env.orch.createStanding({ name: '점검', project_id: a.id, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '확인', 'user');
    await until(() => env.prompts.length > 0);
    await env.orch.idle();
    const before = env.store.getTeam(st.id)!;
    expect(before.worktree_path).toContain('alpha');
    expect(env.store.agentByRole(st.id, 'pm')!.session_id).toBe('s');
    writeFileSync(join(before.worktree_path!, 'README.md'), '# changed\n');

    await env.orch.updateStanding(st.id, { project_id: b.id });
    const after = env.store.getTeam(st.id)!;
    expect(after).toMatchObject({ project_id: b.id, worktree_path: null, branch: null, base_sha: null });
    expect(existsSync(before.worktree_path!)).toBe(false);
    const log = env.store.cleanupLog({ teamId: st.id }).items;
    expect(log).toHaveLength(1);
    expect(log[0]!.patch_files).toBe(1);
    for (const ag of env.store.teamAgents(st.id)) expect(ag.session_id).toBeNull();
    expect(env.store.agentByRole(st.id, 'pm')!.system_prompt).toContain('/mem/beta');
    expect(decisions(env.store, st.id)).toContain('프로젝트 변경: alpha → beta');

    // 같은 값이면 아무것도 하지 않는다
    await env.orch.updateStanding(st.id, { project_id: b.id });
    expect(decisions(env.store, st.id).filter((d) => d.startsWith('프로젝트 변경'))).toHaveLength(1);

    env.orch.message(st.id, '다시 확인', 'user');
    await until(() => env.prompts.length > 1);
    await env.orch.idle();
    expect(env.store.getTeam(st.id)!.worktree_path).toContain('beta');
    await expect(env.orch.updateStanding(st.id, { project_id: 'nope' })).rejects.toThrow(/프로젝트/);
  });

  it('템플릿을 바꾸면 팀원 구성이 새 템플릿대로 바뀌고 세션이 새로 시작된다', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    expect(env.store.teamView(env.store.getTeam(st.id)!).template_id).toBe('tpl-ops');
    const pm0 = env.store.agentByRole(st.id, 'pm')!;
    env.store.updateAgent(pm0.id, { session_id: 'old' });
    await env.orch.updateStanding(st.id, { template_id: 'tpl-dev' });
    const keys = env.store.teamAgents(st.id).map((a) => a.role_key).sort();
    expect(keys).toEqual(['dev', 'pm', 'qa']);
    expect(env.orch.rolesOf(st.id).map((r) => r.key).sort()).toEqual(['dev', 'pm', 'qa']);
    const pm = env.store.agentByRole(st.id, 'pm')!;
    expect(pm.id).toBe(pm0.id);
    expect(pm).toMatchObject({ model: 'opus', session_id: null });
    expect(env.store.agentByRole(st.id, 'dev')!.parent_agent_id).toBe(pm.id);
    expect(env.store.teamView(env.store.getTeam(st.id)!).template_id).toBe('tpl-dev');
    expect(decisions(env.store, st.id)).toContain('템플릿 변경: 운영 점검팀 → 기본 개발팀');
    await expect(env.orch.updateStanding(st.id, { template_id: 'tpl-none' })).rejects.toThrow(/템플릿/);
    // 바뀐 팀원으로 일을 해도 문제없다
    env.orch.message(st.id, '확인', 'user');
    await until(() => env.prompts.length > 0);
    await env.orch.idle();
    expect(env.store.getTeam(st.id)!.state).toBe('idle');
  });

  it('일하는 중에는 프로젝트·템플릿 변경을 거부한다(이름 등은 바꿀 수 있음)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    const slow: TurnRunner = { async runTurn() { await gate; return { ok: true, subtype: 'success', text: '', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10 }; } };
    const orch = new Orchestrator({ cfg: env.cfg, store: env.store, runner: slow, slots: new HeavySlots(2), notifier: new NullNotifier() });
    orch.message(st.id, '오래 걸리는 일', 'user');
    await until(() => orch.isRunning(st.id));
    const { ConflictError } = await import('../server/teams/orchestrator.ts');
    await expect(orch.updateStanding(st.id, { template_id: 'tpl-dev' })).rejects.toBeInstanceOf(ConflictError);
    await expect(orch.updateStanding(st.id, { project_id: proj(env.store, 'gamma').id })).rejects.toThrow(/일하는 중/);
    await orch.updateStanding(st.id, { name: '새 이름' });
    expect(env.store.getTeam(st.id)).toMatchObject({ name: '새 이름', project_id: null });
    expect(env.store.teamAgents(st.id).map((a) => a.role_key).sort()).toEqual(['ops', 'pm']);
    release();
    await orch.idle();
  });
});
