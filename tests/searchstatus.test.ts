import { describe, expect, it } from 'vitest';
import { Search } from '../server/search/index.ts';
import { testEnv } from './helpers.ts';

const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe('검색 색인 상태', () => {
  it('다시 색인 진행·완료 기록 · 모델이 바뀌면 다시 색인 필요로 표시', async () => {
    const { store } = testEnv();
    const search = new Search(store);
    search.embed = async (texts: string[]) => texts.map((t, i) => [t.length % 7, i % 3, 1]);
    store.index('summary', 'a', '결제 오류가 났다', null);
    store.index('summary', 'b', 'PG 승인 실패 대응', null);
    store.saveSettings({ embedding: { provider: 'ollama', model: 'm1', url: 'http://127.0.0.1:11434' } });
    const s0 = search.status();
    if (!s0.vecReady) return; // sqlite-vec 가 없는 환경이면 건너뜀
    expect(s0.docs).toBe(2);
    expect(s0.vectors).toBe(0);

    search.startReindex();
    await until(() => !search.status().job?.running);
    const s1 = search.status();
    expect(s1.vectors).toBe(2);
    expect(s1.indexedWith).toEqual({ provider: 'ollama', model: 'm1' });
    expect(s1.lastFullCount).toBe(2);
    expect(s1.lastFullAt).toBeTruthy();
    expect(s1.modelMismatch).toBe(false);

    store.saveSettings({ embedding: { model: 'm2' } as never });
    expect(search.status().modelMismatch).toBe(true);
    search.startReindex();
    await until(() => !search.status().job?.running);
    expect(search.status()).toMatchObject({ vectors: 2, modelMismatch: false, indexedWith: { model: 'm2' } });

    search.embed = async () => { throw new Error('연결 거부'); };
    search.startReindex();
    await until(() => !search.status().job?.running);
    expect(search.status().job?.error).toBe('연결 거부');
    expect(search.status().lastError).toBe('연결 거부');
  });
});

import { storageReport } from '../server/storage.ts';
describe('총괄 대화 색인 · 빠진 벡터 채우기 · 저장 공간', () => {
  it('총괄 대화가 검색되고, 예전 대화는 한 번 채우며, 빠진 벡터만 채운다', async () => {
    const { cfg, store } = testEnv();
    const search = new Search(store);
    store.addChat({ role: 'user', body: '어제 정산 배치 다시 돌렸어?' });
    store.addChat({ role: 'po', body: '정산 배치는 오늘 새벽에 다시 돌렸습니다' });
    expect((await search.search('정산 배치')).some((h) => h.source_type === 'chat')).toBe(true);
    // 예전 기록(색인 전) 흉내: fts 에서 지우고 다시 채우기
    store.db.prepare("DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM fts_map WHERE source_type = 'chat')").run();
    store.db.prepare("DELETE FROM fts_map WHERE source_type = 'chat'").run();
    store.setKv('chat_indexed_upto', 0);
    expect(store.backfillChatIndex()).toBe(2);
    expect(store.backfillChatIndex()).toBe(0);

    store.saveSettings({ embedding: { provider: 'ollama', model: 'm1', url: 'http://127.0.0.1:11434' } });
    if (!search.status().vecReady) return;
    let calls = 0;
    search.embed = async (texts: string[]) => { calls += texts.length; return texts.map(() => [1, 0, 0]); };
    expect(await search.fillMissing()).toBe(search.status().docs);
    expect(search.status().vectors).toBe(search.status().docs);
    const before = calls;
    expect(await search.fillMissing()).toBe(0); // 다 찼으면 할 일 없음
    expect(calls).toBe(before);

    const r = await storageReport(cfg, store, true);
    expect(r.db.file).toBeGreaterThan(0);
    expect(r.groups.some((g) => g.label === '총괄 대화')).toBe(true);
    expect(r.counts.chat).toBe(2);
  });
});
