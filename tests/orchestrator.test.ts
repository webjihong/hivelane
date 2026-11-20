import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnHandle, TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY } from '../server/store.ts';
import type { TeamTools } from '../server/teams/tools.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';
import { makeRepo, testEnv } from './helpers.ts';

type Script = (spec: TurnSpec, handle: TurnHandle, n: number) => Promise<Partial<TurnResult> | void>;

class FakeRunner implements TurnRunner {
  calls: TurnSpec[] = [];
  constructor(private script: Script) {}
  async runTurn(spec: TurnSpec, handle: TurnHandle): Promise<TurnResult> {
    this.calls.push(spec);
    const r = (await this.script(spec, handle, this.calls.length - 1)) ?? {};
    return { ok: !handle.interrupted, subtype: handle.interrupted ? 'interrupted' : 'success', text: '', costUsd: 0.01, sessionId: `sess-${spec.agent.role_key}`, interrupted: handle.interrupted, error: null, contextTokens: 1000, ...r };
  }
}
const tools = (s: TurnSpec) => s.toolsImpl as TeamTools;

function setup(script: Script) {
  const { cfg, store } = testEnv();
  const repo = makeRepo();
  const project = store.insertProject({ name: 'demo', path: repo, base_ref: 'main', deps_strategy: 'symlink', heavy_patterns: DEFAULT_HEAVY, blocked_patterns: DEFAULT_BLOCKED, memory_paths: [], default_template_id: 'tpl-dev' });
  const runner = new FakeRunner(script);
  const notifier = new NullNotifier();
  const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier });
  const propose = (tpl = 'tpl-dev') => store.insertProposal({ project_id: project.id, title: '더하기 버그 수정', instruction: 'add 고쳐줘', brief: 'app/index.js 의 add 가 빼기를 한다. 고쳐라.', template_id: tpl, roles: store.getTemplate(tpl)!.roles, priority: 'normal', budget_usd: 5, note: '' });
  return { cfg, store, repo, project, runner, notifier, orch, propose };
}
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };

describe('오케스트레이터', () => {
  it('제안 승인 → worktree·의존성 링크 → 계획·구현·보고 → 완료, 변경 수집', async () => {
    const env = setup(async (spec) => {
      const t = tools(spec);
      t.setPlan(['add 를 더하기로', '테스트']);
      t.setStage(1);
      writeFileSync(join(spec.cwd, 'app', 'index.js'), 'export const add = (a, b) => a + b;\n');
      writeFileSync(join(spec.cwd, 'app', 'add.test.js'), 'test\n');
      t.checkItem(0, true);
      t.report('done', 'app/index.js 수정, 테스트 추가');
    });
    const team = env.orch.createFromProposal(env.propose().id);
    expect(team.state).toBe('queued');
    expect(env.store.teamAgents(team.id).map((a) => `${a.role_key}:${a.run_mode}`)).toEqual(['pm:session', 'dev:subagent', 'qa:subagent']);
    await env.orch.start(team.id);
    await env.orch.idle();
    const t = env.store.getTeam(team.id)!;
    expect(t.state).toBe('done');
    expect(t.branch).toMatch(/^hivelane\//);
    expect(existsSync(t.worktree_path!)).toBe(true);
    expect(lstatSync(join(t.worktree_path!, 'app', 'node_modules')).isSymbolicLink()).toBe(true);
    const files = env.store.teamFiles(team.id).map((f) => `${f.path}:${f.change_type}`).sort();
    expect(files).toEqual(['app/add.test.js:added', 'app/index.js:modified']);
    expect(env.store.checklist(team.id)).toEqual([{ idx: 0, text: 'add 를 더하기로', done: true }, { idx: 1, text: '테스트', done: false }]);
    expect(env.store.pendingPoEvents().map((e) => e.type)).toContain('report');
    expect(env.notifier.sent.at(-1)?.title).toBe('업무 완료');
    // 서브에이전트 정의가 PM 세션에 붙었는지
    expect(Object.keys(env.runner.calls[0]!.subagents ?? {})).toEqual(['dev', 'qa']);
    expect(env.runner.calls[0]!.allowedTools).toContain('mcp__hivelane__report');
  });

  it('질문 → 사람 확인 필요 → 답 → 재개 → 완료', async () => {
    const env = setup(async (spec, _h, n) => {
      if (n === 0) { tools(spec).askHuman('90일? 전체?', ['90일', '전체']); return; }
      expect(spec.prompt).toContain('사용자 답변: 90일');
      expect(spec.resume).toBe('sess-pm');
      tools(spec).report('done', '90일 기준으로 끝냄');
    });
    const team = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(team.id); await env.orch.idle();
    const w = env.store.teamView(env.store.getTeam(team.id)!);
    expect(w.state).toBe('waiting_human');
    expect(w.question).toMatchObject({ text: '90일? 전체?', options: ['90일', '전체'] });
    env.orch.answer(team.id, '90일'); await env.orch.idle();
    expect(env.store.getTeam(team.id)!.state).toBe('done');
  });

  it('실행 중 멈춤 → paused, 재개하면 이어서 진행, 그 사이 직접 지시가 전달됨', async () => {
    const env = setup(async (spec, handle, n) => {
      if (n === 0) { while (!handle.pauseRequested) await sleep(10); handle.interrupted = true; return; }
      expect(spec.prompt).toContain('일시정지가 풀렸다');
      expect(spec.injectContext?.()).toContain('768px 도 확인');
      tools(spec).report('done', '끝');
    });
    const team = env.orch.createFromProposal(env.propose().id);
    void env.orch.start(team.id);
    await until(() => env.orch.isRunning(team.id) && env.runner.calls.length === 1);
    await env.orch.pause(team.id, 'engine-soft', '메모리 90%');
    await env.orch.idle();
    expect(env.store.getTeam(team.id)).toMatchObject({ state: 'paused', pause_kind: 'engine-soft' });
    expect(env.orch.message(team.id, '768px 도 확인')).toBe('queued');
    await env.orch.resume(team.id, 'engine', '초록');
    await env.orch.idle();
    expect(env.store.getTeam(team.id)!.state).toBe('done');
  });

  it('report 없이 끝나면 재촉 3번 뒤 사람에게 넘김', async () => {
    const env = setup(async () => ({ text: '다 한 것 같아요' }));
    const team = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(team.id); await env.orch.idle();
    expect(env.runner.calls).toHaveLength(4);
    expect(env.runner.calls[1]!.prompt).toContain('report 를 호출하지 않았다');
    const t = env.store.teamView(env.store.getTeam(team.id)!);
    expect(t.state).toBe('waiting_human');
    expect(t.question?.options).toEqual(['계속 진행', '여기서 마무리']);
    env.orch.answer(team.id, '여기서 마무리');
    expect(env.store.getTeam(team.id)!.state).toBe('done');
  });

  it('독립 세션 팀원에게 delegate → 그 세션을 이어서 실행하고 결과를 PM 에게', async () => {
    const env = setup(async (spec, _h, n) => {
      if (spec.agent.role_key === 'pm') {
        if (n === 0) {
          const r1 = await tools(spec).delegate('dev', 'add 고쳐');
          expect(r1).toBe('고쳤습니다(1)');
          const r2 = await tools(spec).delegate('dev', '테스트도');
          expect(r2).toBe('고쳤습니다(2)');
          tools(spec).report('done', 'ok');
        }
        return;
      }
      expect(spec.agent.role_key).toBe('dev');
      expect(spec.allowedTools).toContain('Edit');
      return { text: `고쳤습니다(${n === 1 ? 1 : 2})`, sessionId: 'dev-sess' };
    });
    const team = env.orch.createFromProposal(env.propose('tpl-big').id);
    await env.orch.start(team.id); await env.orch.idle();
    expect(env.runner.calls.map((c) => `${c.agent.role_key}:${c.resume ?? '-'}`)).toEqual(['pm:-', 'dev:-', 'dev:dev-sess']);
    const msgs = env.store.teamDetail(team.id)!.messages.map((m) => `${m.from_label}>${m.to_label}:${m.kind}`);
    expect(msgs).toEqual(expect.arrayContaining(['PM>개발:handoff', '개발>PM:report']));
    expect(env.store.getTeam(team.id)!.state).toBe('done');
  });

  it('예산 초과 → 질문, +50% 선택 시 예산 늘리고 재개', async () => {
    const env = setup(async (spec, _h, n) => {
      if (n === 0) return { ok: false, subtype: 'error_max_budget_usd', error: '예산 상한에 도달했습니다' };
      tools(spec).report('done', 'ok');
    });
    const team = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(team.id); await env.orch.idle();
    expect(env.store.teamView(env.store.getTeam(team.id)!).question?.options[0]).toContain('+50%');
    env.orch.answer(team.id, '예산 +50% 하고 계속'); await env.orch.idle();
    expect(env.store.getTeam(team.id)).toMatchObject({ state: 'done', budget_usd: 7.5 });
  });

  it('직속 팀: 깨우면 일하고 대기로, 오류는 되살리기', async () => {
    const env = setup(async (spec, _h, n) => {
      if (n === 0) return { text: '점검 완료: 이상 없음' };
      if (n === 1) return { ok: false, subtype: 'exception', error: 'process exited' };
      return { text: '복구 후 처리함' };
    });
    const st = env.orch.createStanding({ name: '서버 점검팀', project_id: null, template_id: 'tpl-ops', brief: '서버를 본다' });
    expect(st).toMatchObject({ state: 'idle', lifetime: 'standing', managed_by: 'user' });
    env.orch.wake(st.id, '지금 점검해');
    await until(() => env.runner.calls.length >= 1); await env.orch.idle();
    expect(env.store.getTeam(st.id)!.state).toBe('idle');
    expect(env.store.teamDetail(st.id)!.messages.at(-1)!.body).toContain('이상 없음');
    env.orch.wake(st.id, '또 점검');
    await until(() => env.runner.calls.length >= 3); await env.orch.idle();
    expect(env.store.getTeam(st.id)).toMatchObject({ state: 'idle', revived_count: 1 });
    expect(env.notifier.sent.map((n) => n.title)).toEqual(expect.arrayContaining(['직속 팀 장애', '직속 팀 복구']));
  });

  it('서버 재시작 복구: 돌던 팀은 대기열로, 세션이 있으면 이어서 시작', async () => {
    const env = setup(async (spec, _h, n) => { if (n === 0) expect(spec.prompt).toContain('서버가 다시 시작'); tools(spec).report('done', 'ok'); });
    const team = env.orch.createFromProposal(env.propose().id);
    const pm = env.store.agentByRole(team.id, 'pm')!;
    env.store.updateAgent(pm.id, { session_id: 'old' });
    env.store.updateTeam(team.id, { state: 'running', started_at: new Date().toISOString() });
    env.orch.recover();
    expect(env.store.getTeam(team.id)!.state).toBe('queued');
    await env.orch.start(team.id); await env.orch.idle();
    expect(env.runner.calls[0]!.resume).toBe('old');
    expect(env.store.getTeam(team.id)!.state).toBe('done');
  });

  it('같은 프로젝트의 다른 팀과 같은 파일을 바꾸면 PO 사건', async () => {
    const env = setup(async (spec) => { writeFileSync(join(spec.cwd, 'app', 'index.js'), `// ${spec.team!.id}\n`); tools(spec).report('done', 'ok'); });
    const a = env.orch.createFromProposal(env.propose().id);
    const b = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(a.id); await env.orch.idle();
    env.store.updateTeam(a.id, { state: 'running' }); // a 가 아직 진행 중인 것처럼
    await env.orch.start(b.id); await env.orch.idle();
    expect(env.store.pendingPoEvents().some((e) => e.type === 'overlap' && e.team_id === b.id)).toBe(true);
  });
});

describe('리뷰 지적 회귀', () => {
  it('H2: 작업 공간 준비 중 중단하면 PM 이 시작되지 않는다', async () => {
    const env = setup(async () => {});
    const team = env.orch.createFromProposal(env.propose().id);
    const started = env.orch.start(team.id);
    expect(env.orch.isRunning(team.id)).toBe(true);
    await env.orch.cancel(team.id);
    await started; await env.orch.idle();
    expect(env.runner.calls).toHaveLength(0);
    expect(env.store.getTeam(team.id)!.state).toBe('failed');
  });

  it('H4: PO 의 전달은 사람 질문(예산)에 답하지 못한다', async () => {
    const env = setup(async (_s, _h, n) => (n === 0 ? { ok: false, subtype: 'error_max_budget_usd', error: '예산' } : undefined));
    const team = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(team.id); await env.orch.idle();
    expect(env.orch.message(team.id, '계속 진행하세요', 'po')).toBe('queued');
    await env.orch.idle();
    expect(env.store.getTeam(team.id)).toMatchObject({ state: 'waiting_human', budget_usd: 5 });
    expect(env.runner.calls).toHaveLength(1);
  });

  it('M9: 질문 대기 중 멈췄다 재개하면 다시 질문 대기로(답 없이 진행하지 않음)', async () => {
    const env = setup(async (spec) => { tools(spec).askHuman('어느 쪽?', ['A', 'B']); });
    const team = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(team.id); await env.orch.idle();
    await env.orch.pause(team.id, 'user', '잠깐');
    expect(env.store.getTeam(team.id)!.state).toBe('paused');
    await env.orch.resume(team.id, 'user');
    await env.orch.idle();
    expect(env.store.getTeam(team.id)!.state).toBe('waiting_human');
    expect(env.runner.calls).toHaveLength(1);
  });

  it('M8: 보관된 직속 팀은 깨우지 않고, 멈춘 직속 팀은 지시를 쌓아 둔다', async () => {
    const env = setup(async () => ({ text: '처리함' }));
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    await env.orch.pause(st.id, 'user', '휴식');
    expect(env.orch.message(st.id, '점검해')).toBe('queued');
    await env.orch.idle();
    expect(env.runner.calls).toHaveLength(0);
    await env.orch.resume(st.id, 'user');
    await until(() => env.runner.calls.length === 1); await env.orch.idle();
    expect(env.runner.calls[0]!.prompt).toContain('점검해');
    await env.orch.cancel(st.id);
    env.orch.wake(st.id, '또');
    await env.orch.idle();
    expect(env.runner.calls).toHaveLength(1);
    expect(env.store.getTeam(st.id)!.state).toBe('archived');
  });

  it('M1: 질문 없는 팀·끝난 팀에는 답할 수 없다', async () => {
    const env = setup(async (spec) => { tools(spec).report('done', 'ok'); });
    const team = env.orch.createFromProposal(env.propose().id);
    expect(() => env.orch.answer(team.id, '네')).toThrow(/질문이 없습니다/);
    await env.orch.start(team.id); await env.orch.idle();
    expect(() => env.orch.answer(team.id, '네')).toThrow();
    expect(() => env.orch.message(team.id, '더 해줘')).toThrow(/끝난 팀/);
  });

  it('M7: 보관 기간이 지난 팀의 세부 기록과 처리된 PO 사건을 정리, 파일 색인은 바뀐 것만', async () => {
    const env = setup(async (spec) => { tools(spec).report('done', 'ok'); });
    const team = env.orch.createFromProposal(env.propose().id);
    await env.orch.start(team.id); await env.orch.idle();
    const pm = env.store.agentByRole(team.id, 'pm')!;
    env.store.addAgentEvent({ agent_id: pm.id, team_id: team.id, kind: 'text', body: 'x' });
    env.store.updateTeam(team.id, { finished_at: '2020-01-01T00:00:00.000Z' });
    const id = env.store.addPoEvent('report', team.id);
    env.store.markPoEventsHandled([id]);
    env.store.db.prepare("UPDATE po_events SET created_at = '2020-01-01T00:00:00.000Z'").run();
    const r = env.store.prune(14);
    expect(r.events).toBeGreaterThan(0);
    expect(r.poEvents).toBeGreaterThan(0);
    // 같은 파일 목록을 다시 넣으면 색인을 새로 만들지 않는다
    const before = (env.store.db.prepare("SELECT count(*) c FROM fts_map WHERE source_type = 'file'").get() as { c: number }).c;
    env.store.replaceFileChanges(team.id, env.store.teamFiles(team.id));
    env.store.replaceFileChanges(team.id, [{ path: 'a.js', change_type: 'added', lines_added: 1, lines_removed: 0 }]);
    const after = env.store.db.prepare("SELECT source_id FROM fts_map WHERE source_type = 'file'").all() as { source_id: string }[];
    expect(before).toBe(0);
    expect(after.map((x) => x.source_id)).toEqual([`${team.id}:a.js`]);
  });
});

describe('검색', () => {
  it('한국어 trigram 검색과 짧은 단어 LIKE, 프로젝트 필터', async () => {
    const { store } = testEnv();
    const s = new Search(store);
    const p = store.insertProject({ name: 'x', path: '/x', base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const t = store.insertTeam({ name: '쿠폰', project_id: p.id });
    store.addMessage({ team_id: t.id, from_label: 'PM', kind: 'report', body: '쿠폰 할인 계산을 고쳤습니다' });
    store.addSummary({ team_id: t.id, stage: '최종', body: '주문 카드 넘침 수정' });
    expect((await s.search('할인 계산')).map((h) => h.text)).toEqual(['쿠폰 할인 계산을 고쳤습니다']);
    expect((await s.search('쿠폰')).length).toBe(1);
    expect((await s.search('넘침', { projectId: p.id })).length).toBe(1);
    expect((await s.search('넘침', { projectId: 'other' })).length).toBe(0);
  });
});
