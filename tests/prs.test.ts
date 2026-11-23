import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NullNotifier } from '../server/notify/index.ts';
import { checksOf, PrWatcher } from '../server/projects/prs.ts';
import { makeRepo, testEnv } from './helpers.ts';

describe('PR 목록', () => {
  it('검사 상태 요약', () => {
    expect(checksOf(null)).toBe('none');
    expect(checksOf([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('pass');
    expect(checksOf([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }])).toBe('pending');
    expect(checksOf([{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toBe('fail');
  });
  it('gh 로 읽어 열린 것 먼저, 오래 닫힌 것 제외, 팀 브랜치로 팀 연결, 팀 PR 새로 생기면 알림', async () => {
    const { cfg, store } = testEnv();
    const repo = makeRepo();
    store.insertProject({ name: 'app', path: repo, base_ref: 'main', deps_strategy: 'none', heavy_patterns: [], blocked_patterns: [], memory_paths: [], default_template_id: null });
    const team = store.insertTeam({ task_id: null, project_id: null, name: '전담', managed_by: 'user', lifetime: 'standing', state: 'idle' });
    store.updateTeam(team.id, { branch: 'fix/rbac' });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const data: { v: Record<string, unknown>[] } = { v: [
      { number: 3, title: '오래 전 병합', url: 'https://g/3', state: 'MERGED', isDraft: false, headRefName: 'x', baseRefName: 'dev', author: { login: 'a' }, createdAt: old, updatedAt: old, mergedAt: old, reviewDecision: null, statusCheckRollup: [] },
      { number: 2, title: '다른 사람 PR', url: 'https://g/2', state: 'OPEN', isDraft: true, headRefName: 'feat', baseRefName: 'dev', author: { login: 'b' }, createdAt: now, updatedAt: now, mergedAt: null, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
    ] };
    const fake = join(cfg.home, 'gh');
    const write = () => { writeFileSync(join(cfg.home, 'prs.json'), JSON.stringify(data.v)); };
    write();
    writeFileSync(fake, `#!/bin/sh\ncat "${join(cfg.home, 'prs.json')}"\n`); chmodSync(fake, 0o755);
    const notifier = new NullNotifier();
    const w = new PrWatcher({ store, notifier, gh: fake });
    await w.refresh();
    expect(w.prs.map((p) => p.number)).toEqual([2]);
    expect(w.prs[0]).toMatchObject({ draft: true, checks: 'pass', review: 'REVIEW_REQUIRED', team_id: null, project_name: 'app' });
    data.v.push({ number: 4, title: 'RBAC 우회 차단', url: 'https://g/4', state: 'OPEN', isDraft: false, headRefName: 'fix/rbac', baseRefName: 'prod', author: { login: 'me' }, createdAt: now, updatedAt: now, mergedAt: null, reviewDecision: null, statusCheckRollup: [] });
    write();
    await w.refresh();
    expect(w.prs.find((p) => p.number === 4)!.team_id).toBe(team.id);
    expect(notifier.sent.map((n) => n.title)).toEqual(['새 PR · app #4']);
    expect(notifier.sent[0]!.url).toBe('https://g/4');
  });
});
