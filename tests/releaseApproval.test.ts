import { describe, expect, it } from 'vitest';
import type { TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { checkBash } from '../server/agents/guard.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { DEFAULT_BLOCKED, effectiveBlocked, gitPushBlocked, splitApproval } from '../server/store.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { matchesAny, sleep } from '../server/util.ts';
import { makeRepo, testEnv } from './helpers.ts';

const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };
const REL = 'gh release create v1.0.1 dist/desktop/Hivelane-1.0.1-arm64.dmg --repo webjihong/hivelane --title "Hivelane v1.0.1" --latest';

describe('gh release: 만들기·올리기·고치기는 승인 대상, 지우기는 하드 차단', () => {
  it('푸시 허용 프로젝트 규칙: create/upload/edit 는 승인으로, delete·PR 병합·저장소 조작은 그대로 막음', () => {
    const { hard, approval } = splitApproval(gitPushBlocked(['main']));
    expect(matchesAny(REL, hard)).toBeNull();
    expect(matchesAny(REL, approval)).not.toBeNull();
    expect(matchesAny('gh release upload v1.0.1 a.dmg', approval)).not.toBeNull();
    expect(matchesAny('gh release edit v1.0.1 --notes x', approval)).not.toBeNull();
    for (const c of ['gh release delete v1.0.1 --yes', 'gh pr merge 3', 'gh repo delete x/y', 'gh api -X DELETE /repos/x/y', 'git push --force origin main']) {
      expect(matchesAny(c, hard)).not.toBeNull();
    }
    // 승인 없이 그냥 실행하려 하면 승인 대상 패턴에 걸린다(하드 차단 아님)
    expect(checkBash(REL, '/tmp', ['/tmp'], hard)).toBeNull();
  });

  async function team(envMode: 'mine' | 'isolated', script: (spec: TurnSpec, n: number) => void) {
    const { cfg, store } = testEnv();
    const project = store.insertProject({ name: 'hivelane', path: makeRepo(), base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: DEFAULT_BLOCKED, memory_paths: [], default_template_id: null, git_mode: 'push', protected_branches: ['prod'] });
    const specs: TurnSpec[] = [];
    const runner: TurnRunner = { async runTurn(spec): Promise<TurnResult> { specs.push(spec); script(spec, specs.length - 1); return { ok: true, subtype: 'success', text: '', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10 }; } };
    const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier: new NullNotifier() });
    const st = orch.createStanding({ name: 'hiveline', project_id: project.id, template_id: 'tpl-ops', brief: 'b' });
    store.updateTeam(st.id, { env_mode: envMode });
    expect(effectiveBlocked(store.getProject(project.id))).toContain('\\bgh\\s+release\\s+(create|upload|edit)\\b');
    return { store, orch, st, specs };
  }
  type Tools = { requestApproval: (c: string, r: string) => string };

  for (const mode of ['mine', 'isolated'] as const) {
    it(`직속 팀(${mode === 'mine' ? '내 환경' : '격리'}): release create → 승인 요청(명령·저장소 표시) → 승인 → 그 명령만 1번`, async () => {
      const out: string[] = [];
      const env = await team(mode, (spec, n) => { if (n === 0) out.push((spec.toolsImpl as Tools).requestApproval(REL, 'v1.0.1 릴리스')); });
      env.orch.message(env.st.id, '릴리스 올려', 'user');
      await until(() => !!env.store.getTeam(env.st.id)!.question);
      await env.orch.idle();
      const s0 = env.specs[0]!;
      expect(s0.allowedTools).toContain('mcp__hivelane__request_approval');
      expect(matchesAny(REL, s0.blockedPatterns ?? [])).toBeNull(); // 하드 차단이 아님
      expect(s0.approval!.take(REL)).toBe(false); // 승인 전엔 실행 불가
      const q = env.store.getTeam(env.st.id)!.question!;
      expect(q).toContain('"kind":"approval"');
      expect(q).toContain('webjihong/hivelane');
      expect(q).toContain('1번에만');
      env.orch.message(env.st.id, '승인', 'user');
      await until(() => env.specs.length > 1);
      await env.orch.idle();
      const s1 = env.specs[1]!;
      expect(s1.approval!.take(REL.replace('v1.0.1 dist', 'v9.9.9 dist'))).toBe(false); // 다른 인자로 재사용 거부
      expect(s1.approval!.take(REL)).toBe(true); // 그 명령 1번
      expect(s1.approval!.take(REL)).toBe(false); // 두 번째는 거부
    });
  }

  it('하드 차단 명령(release delete)은 승인을 묻지 않고 「사람이 직접 실행」으로 안내', async () => {
    const out: string[] = [];
    const env = await team('mine', (spec, n) => { if (n === 0) out.push((spec.toolsImpl as Tools).requestApproval('gh release delete v1.0.1 --yes', '지우기')); });
    env.orch.message(env.st.id, '릴리스 지워', 'user');
    await until(() => env.specs.length > 0);
    await env.orch.idle();
    expect(out[0]).toContain('사람이 직접 실행');
    expect(out[0]).toContain('gh release delete v1.0.1 --yes');
    expect(env.store.getTeam(env.st.id)!.question ?? '').not.toContain('approval');
  });
});
