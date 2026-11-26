import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnHandle, TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { PoAgent } from '../server/po/agent.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY } from '../server/store.ts';
import type { TeamTools } from '../server/teams/tools.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { isActiveTask } from '../web/src/chan.ts';
import type { TeamView } from '../shared/types.ts';
import { makeRepo, testEnv } from './helpers.ts';

type Script = (spec: TurnSpec, handle: TurnHandle) => Promise<Partial<TurnResult> | void>;

function setup(script: Script = async () => {}) {
  const { cfg, store } = testEnv();
  const repo = makeRepo();
  const project = store.insertProject({ name: 'demo', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: DEFAULT_HEAVY, blocked_patterns: DEFAULT_BLOCKED, memory_paths: [], default_template_id: 'tpl-dev' });
  const runner: TurnRunner = { async runTurn(spec, handle) { const r = (await script(spec, handle)) ?? {}; return { ok: true, subtype: 'success', text: '', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10, ...r }; } };
  const notifier = new NullNotifier();
  const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier });
  const po = new PoAgent({ cfg, store, runner, orch, search: new Search(store), notifier });
  const propose = () => store.insertProposal({ project_id: project.id, title: '더하기 고치기', instruction: 'x', brief: 'x', template_id: 'tpl-dev', roles: store.getTemplate('tpl-dev')!.roles, priority: 'normal', budget_usd: null, note: '' });
  return { cfg, store, orch, po, propose };
}
const view = (store: ReturnType<typeof setup>['store'], id: string) => store.teamView(store.getTeam(id)!) as TeamView;

describe('업무 팀을 끝난 팀으로 보내기(보관)', () => {
  it('실패한 팀: worktree 변경을 패치로 남기고 정리한 뒤 archived → 업무 팀 목록에서 빠지고 끝난 팀으로', async () => {
    const env = setup(async (spec) => {
      writeFileSync(join(spec.cwd, 'app', 'index.js'), 'export const add = (a, b) => a + b;\n');
      (spec.toolsImpl as TeamTools).report('failed', '못 끝냄');
    });
    const team = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(team.id); await env.orch.idle();
    const failed = env.store.getTeam(team.id)!;
    expect(failed.state).toBe('failed');
    expect(isActiveTask(view(env.store, team.id))).toBe(true); // 지금까지는 사이드바에 계속 남았다
    const wt = failed.worktree_path!;
    expect(existsSync(wt)).toBe(true);

    await env.orch.closeTask(team.id, '사용자', '이미 PR 로 끝냄');
    const closed = env.store.getTeam(team.id)!;
    expect(closed.state).toBe('archived');
    expect(closed.worktree_path).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(isActiveTask(view(env.store, team.id))).toBe(false);
    expect(env.store.finishedCount().archived).toBe(1);
    const log = env.store.db.prepare('SELECT patch_files, branch FROM cleanup_log WHERE team_id = ?').get(team.id) as { patch_files: number; branch: string } | undefined;
    expect(log?.patch_files).toBeGreaterThan(0);
    expect(log?.branch).toBe(failed.branch);
  });

  it('멈춘 팀·대기열 팀도 보낼 수 있다(worktree 가 없으면 상태만)', async () => {
    const env = setup();
    const paused = env.orch.createFromProposal(env.propose().id);
    env.store.updateTeam(paused.id, { state: 'paused', pause_kind: 'user', paused_reason: '사용자가 멈춤' });
    await env.orch.closeTask(paused.id);
    expect(env.store.getTeam(paused.id)).toMatchObject({ state: 'archived', paused_reason: null });

    const queued = env.orch.createFromProposal(env.propose().id);
    expect(env.store.getTeam(queued.id)!.state).toBe('queued');
    await env.orch.closeTask(queued.id);
    expect(env.store.getTeam(queued.id)!.state).toBe('archived');
    expect(env.store.getTask(env.store.getTeam(queued.id)!.task_id!)?.status).toBe('done');
  });

  it('직속 팀·일하는 팀·이미 끝난 팀은 거부', async () => {
    const env = setup();
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    await expect(env.orch.closeTask(st.id)).rejects.toThrow('직속 팀');
    const tm = env.orch.createFromProposal(env.propose().id);
    env.store.updateTeam(tm.id, { state: 'running' });
    await expect(env.orch.closeTask(tm.id)).rejects.toThrow('일하는 중');
    env.store.updateTeam(tm.id, { state: 'done' });
    await expect(env.orch.closeTask(tm.id)).rejects.toThrow('이미 끝난');
  });

  it('총괄 도구 archive_team: 같은 동작, 안 되는 팀은 이유를 돌려준다', async () => {
    const env = setup();
    const tm = env.orch.createFromProposal(env.propose().id);
    env.store.updateTeam(tm.id, { state: 'failed' });
    const tools = env.po.tools();
    expect(await tools.archiveTeam(tm.id, '사용자가 닫으라고 함')).toContain('끝난 팀으로 보냈다');
    expect(env.store.getTeam(tm.id)!.state).toBe('archived');
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    expect(await tools.archiveTeam(st.id, 'x')).toContain('보내지 못했다');
  });
});
