import { describe, expect, it } from 'vitest';
import type { TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { PoAgent } from '../server/po/agent.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { sleep } from '../server/util.ts';
import { testEnv } from './helpers.ts';

const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };

function setup(poSays: (prompt: string) => string) {
  const { cfg, store } = testEnv();
  const poPrompts: string[] = [];
  const runner: TurnRunner = {
    async runTurn(spec: TurnSpec): Promise<TurnResult> {
      if (spec.label === 'PO') { poPrompts.push(spec.prompt); return { ok: true, subtype: 'success', text: poSays(spec.prompt), costUsd: 0, sessionId: 'po', interrupted: false, error: null, contextTokens: 10 }; }
      (spec.toolsImpl as { report: (s: string, t: string) => void }).report('done', '**결론: 앱 주문 여부는 주문서 만들 때 정해짐**');
      return { ok: true, subtype: 'success', text: '', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 10 };
    },
  };
  const notifier = new NullNotifier();
  const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier });
  const po = new PoAgent({ cfg, store, runner, orch, search: new Search(store), notifier });
  return { store, orch, po, poPrompts, notifier };
}

describe('PO 가 맡긴 일의 답을 사용자에게 전함', () => {
  it('직속 팀이 PO 지시에 답하면 PO 가 「팀 답변」 사건과 답 내용을 받고, PO 가 말하면 그 말이 대화창에', async () => {
    const env = setup((p) => (p.includes('팀 답변(PO가 맡긴 일)') ? '**결론: 주문서 만들 때 정해집니다.**' : '-'));
    const st = env.orch.createStanding({ name: '궁금증해결', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '앱 주문 기준 알아봐', 'po');
    await until(() => env.store.chat(50).some((c) => c.role === 'po' && c.body.includes('주문서 만들 때')));
    expect(env.poPrompts.at(-1)).toContain('팀 답:');
    expect(env.poPrompts.at(-1)).toContain('주문서 만들 때 정해짐');
    const last = env.store.chat(50).filter((c) => c.role === 'po').at(-1)!;
    expect(last.links?.[0]?.href).toBe(`#team-${st.id}`);
    expect(env.notifier.sent.some((n) => n.title === 'PO · 팀 답변 전달')).toBe(true);
  });
  it('PO 가 "-" 로 넘겨도 팀 답은 그대로 대화창에 전달', async () => {
    const env = setup(() => '-');
    const st = env.orch.createStanding({ name: '궁금증해결', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '앱 주문 기준 알아봐', 'po');
    await until(() => env.store.chat(50).some((c) => c.role === 'po' && c.body.includes('답변이 왔습니다')));
    expect(env.store.pendingPoEvents()).toHaveLength(0);
    expect(env.store.poUnread()).toBeGreaterThan(0);
  });
  it('사용자가 직접 시킨 일은 PO 에게 넘기지 않는다(사용자에게 바로)', async () => {
    const env = setup(() => '-');
    const st = env.orch.createStanding({ name: '궁금증해결', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, '직접 물어봄', 'user');
    await until(() => env.store.getTeam(st.id)!.state === 'idle' && env.store.teamUnread(st.id) > 0);
    await sleep(3500);
    expect(env.store.db.prepare("SELECT count(*) n FROM po_events WHERE type = 'team_reply'").get()).toEqual({ n: 0 });
  });
});

describe('직접 지시한 업무팀 완료는 PO 가 다시 전하지 않음', () => {
  it('사용자가 업무팀 채널에서 지시해 끝나면 report 사건은 가도(asked_by=사용자) 대화창 대신 전달은 없음', async () => {
    const env = setup(() => '-');
    const prop = env.store.insertProposal({ project_id: null, title: '조사', instruction: 'x', brief: 'x', template_id: 'tpl-research', roles: env.store.getTemplate('tpl-research')!.roles, priority: 'normal', budget_usd: null, note: '' });
    const team = env.orch.createFromProposal(prop.id);
    env.store.addMessage({ team_id: team.id, from_label: '사용자', to_label: 'PM', kind: 'instruction', body: '직접 지시' });
    await env.orch.start(team.id);
    await until(() => env.store.getTeam(team.id)!.state === 'done');
    await until(() => env.store.pendingPoEvents().length === 0, 8000);
    expect(env.poPrompts.at(-1)).toContain('사용자가 팀 채널에서 직접 시킨 일');
    expect(env.store.chat(50).some((c) => c.body.includes('답변이 왔습니다'))).toBe(false);
  });
});
