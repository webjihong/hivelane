import { describe, expect, it } from 'vitest';
import { createApp } from '../server/http/app.ts';
import { NullNotifier } from '../server/notify/index.ts';
import { Engine } from '../server/po/engine.ts';
import { PoAgent } from '../server/po/agent.ts';
import { HeavySlots } from '../server/po/slots.ts';
import { Search } from '../server/search/index.ts';
import { Orchestrator, type TurnRunner } from '../server/teams/orchestrator.ts';
import { makeRepo, testEnv } from './helpers.ts';

function app() {
  const { cfg, store } = testEnv();
  const runner: TurnRunner = { runTurn: async () => ({ ok: true, subtype: 'success', text: '-', costUsd: 0, sessionId: 's', interrupted: false, error: null, contextTokens: 0 }) };
  const slots = new HeavySlots(1);
  const notifier = new NullNotifier();
  const orch = new Orchestrator({ cfg, store, runner, slots, notifier });
  const search = new Search(store);
  const engine = new Engine({ store, orch, slots, sampler: { cpu: () => 10, mem: async () => 30, procs: async () => [] } });
  const po = new PoAgent({ cfg, store, runner, orch, search, notifier });
  return { a: createApp({ cfg, store, orch, engine, po, search, notifier }), store };
}
const json = (b: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

describe('HTTP 접근 제어', () => {
  it('로컬은 전부, 원격은 주인 계정만 + 설정 변경 불가', async () => {
    const { a, store } = app();
    expect((await a.request('/api/state')).status).toBe(200);
    const remote = { headers: { 'tailscale-user-login': 'webjihong@gmail.com' } };
    const r1 = await a.request('/api/state', remote);
    expect(r1.status).toBe(403);
    expect((await r1.json()).error).toContain('주인');
    store.saveSettings({ ownerLogin: 'webjihong@gmail.com' });
    const r2 = await a.request('/api/state', remote);
    expect(r2.status).toBe(200);
    expect((await r2.json()).access).toBe('remote');
    expect((await a.request('/api/state', { headers: { 'tailscale-user-login': 'other@x' } })).status).toBe(403);
    const r3 = await a.request('/api/settings', { method: 'PUT', headers: { 'tailscale-user-login': 'webjihong@gmail.com', 'content-type': 'application/json' }, body: '{"autoApprove":true}' });
    expect(r3.status).toBe(403);
    expect((await a.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"autoApprove":true}' })).status).toBe(200);
    expect(store.getSettings().autoApprove).toBe(true);
  });

  it('프로젝트 등록·중복 거절·입력 검증, 제안 승인(원격은 확인 필요)', async () => {
    const { a, store } = app();
    const repo = makeRepo();
    const r = await a.request('/api/projects', json({ path: repo }));
    expect(r.status).toBe(200);
    const p = await r.json();
    expect(p).toMatchObject({ base_ref: 'main', deps_strategy: 'symlink' });
    expect((await a.request('/api/projects', json({ path: repo }))).status).toBe(409);
    expect((await a.request('/api/projects', json({ path: '/nope/none' }))).status).toBe(500);
    expect((await a.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"engine":{"cap":0}}' })).status).toBe(400);

    const prop = store.insertProposal({ project_id: p.id, title: 'x', instruction: 'x', brief: 'x', template_id: 'tpl-dev', roles: store.getTemplate('tpl-dev')!.roles, priority: 'normal', budget_usd: 3, note: '' });
    store.saveSettings({ ownerLogin: 'me@x' });
    const remote = (b: unknown) => ({ ...json(b), headers: { 'content-type': 'application/json', 'tailscale-user-login': 'me@x' } });
    expect((await a.request(`/api/proposals/${prop.id}/approve`, remote({}))).status).toBe(409);
    const ok = await a.request(`/api/proposals/${prop.id}/approve`, remote({ confirm: true, priority: 'urgent' }));
    expect(ok.status).toBe(200);
    const team = (await ok.json()).team;
    expect(team).toMatchObject({ state: 'queued', priority: 'urgent' });
    expect((await a.request(`/api/teams/${team.id}`)).status).toBe(200);
    expect((await a.request('/api/teams/none')).status).toBe(404);
  });
});
