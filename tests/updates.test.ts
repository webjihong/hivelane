import { describe, expect, it } from 'vitest';
import { installKind, isNewer, UpdateChecker } from '../server/updates.ts';
import { testEnv } from './helpers.ts';

const release = (tag: string) => (async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/webjihong/hivelane/releases/tag/${tag}`, published_at: '2026-11-27T00:00:00Z', body: '- 고친 것' }), { status: 200 })) as unknown as typeof fetch;

describe('새 버전 확인', () => {
  it('버전 비교는 숫자로', () => {
    expect(isNewer('1.0.10', '1.0.9')).toBe(true);
    expect(isNewer('v1.1.0', '1.0.2')).toBe(true);
    expect(isNewer('1.0.2', '1.0.2')).toBe(false);
    expect(isNewer('1.0.1', '1.0.2')).toBe(false);
    expect(isNewer('2.0.0-beta', '1.9.9')).toBe(true);
  });

  it('설치 방식: Caskroom 이 있으면 brew, 앱 안 서버면 app, 아니면 source', () => {
    expect(installKind((p) => p === '/opt/homebrew/Caskroom/hivelane', {})).toBe('brew');
    expect(installKind(() => false, { ELECTRON_RUN_AS_NODE: '1' })).toBe('app');
    expect(installKind(() => false, {})).toBe('source');
  });

  it('새 버전이 있으면 알려 주고, 같은 버전 알림은 한 번만', async () => {
    const { store } = testEnv();
    const sent: string[] = [];
    let changed = 0;
    const u = new UpdateChecker({ store, current: '1.0.2', kind: 'brew', fetch: release('v1.0.3'), notify: (title) => sent.push(title), onChange: () => changed++ });
    expect(u.view()).toMatchObject({ current: '1.0.2', latest: null, hasUpdate: false });
    const v = await u.check();
    expect(v).toMatchObject({ latest: '1.0.3', hasUpdate: true, install: 'brew', error: null });
    expect(v.url).toContain('v1.0.3');
    await u.check();
    expect(sent).toHaveLength(1);
    expect(changed).toBe(2);
  });

  it('최신이면 알림 없음 · 실패해도 마지막 결과는 남는다', async () => {
    const { store } = testEnv();
    const sent: string[] = [];
    const ok = new UpdateChecker({ store, current: '1.0.3', kind: 'app', fetch: release('v1.0.3'), notify: (t) => sent.push(t), onChange: () => {} });
    expect((await ok.check()).hasUpdate).toBe(false);
    const down = new UpdateChecker({ store, current: '1.0.3', kind: 'app', fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch, notify: (t) => sent.push(t), onChange: () => {} });
    const v = await down.check();
    expect(v.latest).toBe('1.0.3');
    expect(v.error).toContain('503');
    expect(sent).toHaveLength(0);
  });
});
