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
