import { describe, expect, it } from 'vitest';
import { poPrompt } from '../server/agents/prompts.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { testEnv } from './helpers.ts';

describe('PO 학습', () => {
  it('저장·같은 이름 갱신·검색 색인·삭제', () => {
    const { store } = testEnv();
    const a = store.saveKnowledge({ kind: 'skill', name: 'cpu-원인', when_to_use: 'CPU 높을 때', body: '1. system_status\n2. 출처별 합계 확인' });
    expect(a.created).toBe(true);
    const b = store.saveKnowledge({ kind: 'skill', name: 'cpu-원인', body: '고친 절차' });
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    expect(b.row.when_to_use).toBe('CPU 높을 때');
    expect(store.knowledgeCount()).toBe(1);
    const hits = store.db.prepare("SELECT text FROM search_fts WHERE source_type = 'knowledge'").all() as { text: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain('고친 절차');
    store.touchKnowledge(a.row.id);
    expect(store.getKnowledge('cpu-원인')!.uses).toBe(1);
    expect(store.deleteKnowledge('cpu-원인')).toBe(true);
    expect(store.knowledgeCount()).toBe(0);
    expect((store.db.prepare("SELECT count(*) n FROM search_fts WHERE source_type = 'knowledge'").get() as { n: number }).n).toBe(0);
  });
  it('프롬프트: 스킬은 목록만, 메모는 본문, 길면 잘라 알림', () => {
    const now = new Date().toISOString();
    const k = (kind: 'skill' | 'note', name: string, body: string, when = '') => ({ id: name, kind, name, when_to_use: when, body, source: '', uses: 0, last_used_at: null, created_at: now, updated_at: now });
    const p = poPrompt([], [k('skill', 'cpu-원인', '비밀 절차 본문', 'CPU 높을 때'), k('note', '앱', 'my-app 은 알림 플랫폼'), k('note', '긴것', 'x'.repeat(7000))]);
    expect(p).toContain('- cpu-원인 — CPU 높을 때');
    expect(p).not.toContain('비밀 절차 본문');
    expect(p).toContain('- 앱: my-app 은 알림 플랫폼');
    expect(p).toContain('메모 1개는 길어서 생략');
  });
  it('예산 기본값은 무제한', () => {
    expect(DEFAULT_SETTINGS.defaultBudgetUsd).toBeNull();
  });
});
