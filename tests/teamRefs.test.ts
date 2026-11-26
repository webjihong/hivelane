import { describe, expect, it } from 'vitest';
import { shortName, splitTeamRefs, withTeamNames } from '../shared/teamRefs.ts';
import { testEnv } from './helpers.ts';

const names: Record<string, string> = { 'tm-yjbjfdbd0': '사전구매 hotfix — 기간 종료 시 활성 유지 · 관리자 비활성=사전구매 종료', 's-8yguc279b': 'AI 연동' };
const look = (id: string) => (names[id] ? { name: names[id]! } : undefined);

describe('글 속 팀 id → 팀 이름', () => {
  it('id 만 쓴 곳에 이름이 붙는다(끝난 업무 팀은 업무 제목)', () => {
    expect(splitTeamRefs('| tm-yjbjfdbd0 | 완료 |', look)).toEqual(['| ', { id: 'tm-yjbjfdbd0', name: names['tm-yjbjfdbd0'] }, ' | 완료 |']);
  });

  it('이미 「이름(id)」·「이름 (id)」·「이름 · id」로 쓴 곳은 이름이 두 번 나오지 않는다', () => {
    expect(splitTeamRefs('AI 연동(s-8yguc279b) 확인', look)).toEqual([{ id: 's-8yguc279b', name: 'AI 연동' }, ' 확인']);
    expect(splitTeamRefs('팀: AI 연동 (s-8yguc279b)', look)).toEqual(['팀: ', { id: 's-8yguc279b', name: 'AI 연동' }]);
    expect(splitTeamRefs('AI 연동 · s-8yguc279b', look)).toEqual([{ id: 's-8yguc279b', name: 'AI 연동' }]);
    // 다른 이름이 앞에 있으면 그대로 두고 id 만 칩
    expect(splitTeamRefs('예전 이름(s-8yguc279b)', look)).toEqual(['예전 이름(', { id: 's-8yguc279b', name: 'AI 연동' }, ')']);
  });

  it('모르는 id·id 비슷한 낱말은 그대로', () => {
    expect(splitTeamRefs('tm-zzzzzzzzz 와 hivelane/s-mpyymf4be-x 는 그대로', look)).toEqual(['tm-zzzzzzzzz 와 hivelane/s-mpyymf4be-x 는 그대로']);
  });

  it('알림 글: 「이름(id)」로 바꾸되 ``` 코드 블록 안은 그대로', () => {
    expect(withTeamNames('s-8yguc279b 답변\n```\ngit log s-8yguc279b\n```\n끝', look)).toBe('AI 연동(s-8yguc279b) 답변\n```\ngit log s-8yguc279b\n```\n끝');
    expect(withTeamNames('AI 연동(s-8yguc279b)', look)).toBe('AI 연동(s-8yguc279b)');
  });

  it('긴 제목은 줄인다', () => {
    expect(shortName(names['tm-yjbjfdbd0']!)).toHaveLength(22);
    expect(shortName(names['tm-yjbjfdbd0']!).endsWith('…')).toBe(true);
    expect(shortName('AI 연동')).toBe('AI 연동');
  });

  it('서버 팀 이름 사전: 끝난·보관 팀 포함, 업무 팀은 업무 제목', () => {
    const { store } = testEnv();
    const task = store.insertTask({ project_id: null, title: '로그인 버그 수정', instruction: 'x', brief: 'x', priority: 'normal', template_id: null, budget_usd: null });
    store.db.prepare("INSERT INTO teams (id, task_id, name, state, created_at, updated_at) VALUES ('tm-done00001', ?, '기본 개발팀', 'archived', 'x', 'x')").run(task.id);
    store.db.prepare("INSERT INTO teams (id, name, lifetime, state, created_at, updated_at) VALUES ('s-stand0001', '인프라', 'standing', 'idle', 'x', 'x')").run();
    expect(store.teamNames()).toMatchObject({ 'tm-done00001': '로그인 버그 수정', 's-stand0001': '인프라' });
  });
});

describe('화면(RichText): 팀 칩', () => {
  it('표·본문의 id 는 칩(이름·링크·툴팁), 「이름(id)」는 한 번만, ``` 안은 그대로, 모르는 id 그대로', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { RichText } = await import('../web/src/ui.tsx');
    const { primeTeamNames } = await import('../web/src/teamNames.ts');
    primeTeamNames({ 'tm-yjbjfdbd0': names['tm-yjbjfdbd0']!, 's-8yguc279b': 'AI 연동' });
    const html = renderToStaticMarkup(createElement(RichText, { text: '| 팀 | 상태 |\n|---|---|\n| AI 연동(s-8yguc279b) | 대기 |\n| tm-yjbjfdbd0 | 완료 |\n\n`tm-yjbjfdbd0` 와 tm-zzzzzzzzz\n```\ngit branch hivelane/tm-yjbjfdbd0 tm-yjbjfdbd0\n```' }));
    expect(html).toContain('href="#team-tm-yjbjfdbd0"');
    expect(html).toContain(`title="${names['tm-yjbjfdbd0']} · tm-yjbjfdbd0"`);
    expect(html).toContain('사전구매 hotfix');
    expect(html.match(/AI 연동/g)).toHaveLength(2); // 칩 이름 + 툴팁(본문엔 한 번)
    expect(html).toContain('tm-zzzzzzzzz');
    expect(html).not.toContain('href="#team-tm-zzzzzzzzz"');
    expect(html).toContain('<pre class="rt-code"><code>git branch hivelane/tm-yjbjfdbd0 tm-yjbjfdbd0</code></pre>');
  });
});
