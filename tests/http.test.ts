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
  const a = createApp({ cfg, store, orch, engine, po, search, notifier });
  /** 실제 리스너처럼 요청: remote=true 면 tailscale serve 전용 포트로 들어온 것 */
  const req = (path: string, o: { method?: string; body?: unknown; remote?: boolean; login?: string; host?: string; origin?: string; csrf?: boolean; contentType?: string } = {}) => {
    const remote = !!o.remote;
    const headers: Record<string, string> = { host: o.host ?? (remote ? 'mac.tail1234.ts.net' : `127.0.0.1:${cfg.port}`) };
    if (o.login) headers['tailscale-user-login'] = o.login;
    if (o.origin) headers.origin = o.origin;
    const method = o.method ?? (o.body === undefined ? 'GET' : 'POST');
    if (method !== 'GET') {
      headers['content-type'] = o.contentType ?? 'application/json';
      if (o.csrf !== false) headers['x-hivelane'] = '1';
    }
    return a.request(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(o.body ?? {}) }, { incoming: { socket: { localPort: remote ? cfg.remotePort : cfg.port, remoteAddress: '127.0.0.1' } } });
  };
  return { req, store, orch, cfg };
}

describe('HTTP 접근 제어', () => {
  it('로컬은 전부, 원격 포트는 주인 계정만 + 설정 변경 불가', async () => {
    const { req, store } = app();
    expect((await req('/api/state')).status).toBe(200);
    const r1 = await req('/api/state', { remote: true, login: 'webjihong@gmail.com' });
    expect(r1.status).toBe(403);
    expect((await r1.json()).error).toContain('주인');
    store.saveSettings({ ownerLogin: 'webjihong@gmail.com' });
    const r2 = await req('/api/state', { remote: true, login: 'webjihong@gmail.com' });
    expect(r2.status).toBe(200);
    expect((await r2.json()).access).toBe('remote');
    expect((await req('/api/state', { remote: true, login: 'other@x' })).status).toBe(403);
    expect((await req('/api/settings', { method: 'PUT', body: { autoApprove: true }, remote: true, login: 'webjihong@gmail.com' })).status).toBe(403);
    expect((await req('/api/settings', { method: 'PUT', body: { autoApprove: true } })).status).toBe(200);
    expect(store.getSettings().autoApprove).toBe(true);
  });

  it('원격 포트로 신원 헤더 없이 오면(태그 기기 등) 로컬 권한을 주지 않는다', async () => {
    const { req, store } = app();
    store.saveSettings({ ownerLogin: 'me@x' });
    const r = await req('/api/settings', { method: 'PUT', body: { autoApprove: true }, remote: true });
    expect(r.status).toBe(403);
    expect(store.getSettings().autoApprove).toBe(false);
  });

  it('CSRF: 다른 사이트의 text/plain·헤더 없는 요청, 다른 Origin, 낯선 Host(리바인딩)를 거부', async () => {
    const { req, store } = app();
    const evil = { name: 'x', template_id: 'tpl-ops', check_command: 'touch /tmp/pwned', check_interval_sec: 30 };
    expect((await req('/api/standing', { body: evil, contentType: 'text/plain', csrf: false })).status).toBe(403);
    expect((await req('/api/standing', { body: evil, csrf: false })).status).toBe(403);
    expect((await req('/api/standing', { body: evil, origin: 'https://evil.example' })).status).toBe(403);
    expect((await req('/api/state', { host: 'evil.example:4310' })).status).toBe(403);
    expect(store.listTeams().length).toBe(0);
    expect((await req('/api/standing', { body: evil, origin: 'http://127.0.0.1:4310' })).status).toBe(200);
  });

  it('프로젝트 등록·중복 거절·입력 검증, 제안 승인(원격은 확인 필요)', async () => {
    const { req, store } = app();
    const repo = makeRepo();
    const r = await req('/api/projects', { body: { path: repo } });
    expect(r.status).toBe(200);
    const p = await r.json();
    expect(p).toMatchObject({ base_ref: 'main', deps_strategy: 'symlink' });
    expect((await req('/api/projects', { body: { path: repo } })).status).toBe(409);
    expect((await req('/api/projects', { body: { path: '/nope/none' } })).status).toBe(500);
    expect((await req('/api/settings', { method: 'PUT', body: { engine: { cap: 0 } } })).status).toBe(400);

    const prop = store.insertProposal({ project_id: p.id, title: 'x', instruction: 'x', brief: 'x', template_id: 'tpl-dev', roles: store.getTemplate('tpl-dev')!.roles, priority: 'normal', budget_usd: 3, note: '' });
    store.saveSettings({ ownerLogin: 'me@x' });
    expect((await req(`/api/proposals/${prop.id}/approve`, { body: {}, remote: true, login: 'me@x' })).status).toBe(409);
    const ok = await req(`/api/proposals/${prop.id}/approve`, { body: { confirm: true, priority: 'urgent' }, remote: true, login: 'me@x' });
    expect(ok.status).toBe(200);
    const team = (await ok.json()).team;
    expect(team).toMatchObject({ state: 'queued', priority: 'urgent' });
    expect((await req(`/api/teams/${team.id}`)).status).toBe(200);
    expect((await req('/api/teams/none')).status).toBe(404);
    // 질문이 없는 팀에 답하기 → 409
    expect((await req(`/api/teams/${team.id}/answer`, { body: { text: '네' } })).status).toBe(409);
  });
});
