import { describe, expect, it } from 'vitest';
import type { TurnHandle, TurnResult, TurnSpec } from '../server/agents/runner.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { PoAgent } from '../server/po/agent.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { forAgent, readUpload, saveUpload } from '../server/uploads.ts';
import { sleep } from '../server/util.ts';
import { testEnv } from './helpers.ts';

const until = async (f: () => boolean, ms = 6000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64');

describe('이미지 첨부', () => {
  it('저장·읽기·종류 제한·에이전트용 경로 변환', () => {
    const { cfg } = testEnv();
    const id = saveUpload(cfg, 'image/png', PNG);
    expect(id).toMatch(/^u-[a-z0-9]{12}\.png$/);
    expect(readUpload(cfg, id)!.type).toBe('image/png');
    expect(readUpload(cfg, '../hivelane.db')).toBeNull();
    expect(() => saveUpload(cfg, 'text/html', PNG)).toThrow(/이미지/);
    const t = forAgent(cfg, `이거 봐\n\n![캡처](/api/uploads/${id})`);
    expect(t).toContain(`${cfg.uploadsDir}/${id}`);
    expect(t).toContain('Read 도구');
  });
});

function setup(block = true) {
  const { cfg, store } = testEnv();
  const prompts: string[] = [];
  const dirs: string[][] = [];
  const runner: TurnRunner = {
    async runTurn(spec: TurnSpec, h: TurnHandle): Promise<TurnResult> {
      prompts.push(spec.prompt);
      dirs.push(spec.additionalDirectories ?? []);
      if (block) { const orig = h.interrupt.bind(h); let stop = false; h.interrupt = async () => { stop = true; h.interrupted = true; await orig().catch(() => {}); }; while (!stop) await sleep(10); }
      return { ok: !h.interrupted, subtype: h.interrupted ? 'interrupted' : 'success', text: '답', costUsd: 0, sessionId: 's', interrupted: h.interrupted, error: null, contextTokens: 10 };
    },
  };
  const orch = new Orchestrator({ cfg, store, runner, slots: new HeavySlots(2), notifier: new NullNotifier() });
  const po = new PoAgent({ cfg, store, runner, orch, search: new Search(store), notifier: new NullNotifier() });
  return { cfg, store, orch, po, prompts, dirs };
}

describe('진행 중 취소', () => {
  it('직속 팀: 진행 취소하면 대기로, 쌓인 지시는 버림 · 이미지 경로가 PM 에 전달', async () => {
    const env = setup();
    const id = saveUpload(env.cfg, 'image/png', PNG);
    const st = env.orch.createStanding({ name: '점검', project_id: null, template_id: 'tpl-ops', brief: 'b' });
    env.orch.message(st.id, `이 화면 봐 ![s](/api/uploads/${id})`, 'user');
    await until(() => env.prompts.length > 0);
    expect(env.prompts[0]).toContain(`${env.cfg.uploadsDir}/${id}`);
    expect(env.dirs[0]).toContain(env.cfg.uploadsDir);
    env.orch.message(st.id, '그리고 이것도', 'user');
    expect(await env.orch.cancelTurn(st.id)).toBe(true);
    await env.orch.idle();
    expect(env.store.getTeam(st.id)!.state).toBe('idle');
    expect(env.prompts).toHaveLength(1);
    expect(await env.orch.cancelTurn(st.id)).toBe(false);
  });
  it('PO: 취소하면 응답 대신 「취소함」 기록', async () => {
    const env = setup();
    env.po.say('길게 생각해');
    await until(() => env.po.busy && env.prompts.length > 0);
    expect(await env.po.cancel()).toBe(true);
    await until(() => !env.po.busy);
    const chat = env.store.chat(10).map((c) => `${c.role}:${c.body}`);
    expect(chat.at(-1)).toBe('event:사용자가 총괄 응답을 취소함');
  });
});
