import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initServerI18n, isOpt, st } from '../server/i18n.ts';
import { SERVER_EN } from '../server/locales/en/index.ts';

const ROOT = join(import.meta.dirname, '..');
const HANGUL = /[가-힣]/;

/** 파일에서 st('…') 의 첫 인자(문자열 그대로 쓴 것만) */
function keysIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bst\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]!.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1'));
  return out.filter((k) => HANGUL.test(k) && !k.includes('${'));
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'locales' ? [] : tsFiles(p);
    return f.endsWith('.ts') && f !== 'i18n.ts' ? [p] : []; // i18n.ts 는 주석 속 예시뿐
  });
}

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => initServerI18n(() => 'ko', {}));

describe('서버 글 영어 번역', () => {
  it('server/ 의 st() 문구는 모두 영어가 있고, {자리표시}가 같다', () => {
    const missing: string[] = [];
    const badHoles: string[] = [];
    let n = 0;
    for (const f of tsFiles(join(ROOT, 'server'))) {
      for (const k of keysIn(readFileSync(f, 'utf8'))) {
        n++;
        const rel = f.slice(ROOT.length + 1);
        if (!(k in SERVER_EN)) missing.push(`${rel}: ${k}`);
        else if (JSON.stringify(holes(k)) !== JSON.stringify(holes(SERVER_EN[k]!))) badHoles.push(`${rel}: ${k} → ${SERVER_EN[k]}`);
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(missing).toEqual([]);
    expect(badHoles).toEqual([]);
  });

  it('영어 사전 값에 한국어가 남아 있지 않다', () => {
    expect(Object.entries(SERVER_EN).filter(([, v]) => HANGUL.test(v)).map(([k]) => k)).toEqual([]);
  });

  it('settings.lang 이 en 이면 영어, ko 면 한국어', () => {
    let lang: 'ko' | 'en' = 'en';
    initServerI18n(() => lang, SERVER_EN);
    expect(st('팀 오류')).toBe('Team error');
    expect(st('{name} 답변', { name: 'A' })).toBe('A replied');
    lang = 'ko';
    expect(st('팀 오류')).toBe('팀 오류');
    expect(st('{name} 답변', { name: 'A' })).toBe('A 답변');
  });

  it('선택지 비교는 한국어·영어 둘 다 받는다', () => {
    initServerI18n(() => 'en', SERVER_EN);
    expect(isOpt('여기서 마무리', '여기서 마무리')).toBe(true);
    expect(isOpt(st('여기서 마무리'), '여기서 마무리')).toBe(true);
    expect(isOpt('wrap up here', '여기서 마무리')).toBe(true);
    expect(isOpt('계속 진행', '여기서 마무리')).toBe(false);
    expect(isOpt('Continue', '여기서 마무리')).toBe(false);
    initServerI18n(() => 'ko', SERVER_EN);
    expect(isOpt('Wrap up here', '여기서 마무리')).toBe(true); // 언어를 바꾸기 전에 만든 선택지도 받는다
  });
});

describe('AI 답 언어(설정 › 총괄·엔진)', () => {
  it('영어면 총괄·PM·역할 지시문에 영어로 답하라는 규칙, 한국어면 한국어 규칙', async () => {
    const { initServerI18n } = await import('../server/i18n.ts');
    const { pmPrompt, poPrompt, rolePrompt } = await import('../server/agents/prompts.ts');
    const role = { key: 'dev', name: '개발', model: 'sonnet' as const, mode: 'session' as const, tools: 'write' as const };
    initServerI18n(() => 'en', {});
    for (const p of [poPrompt([]), pmPrompt({ roles: [{ ...role, key: 'pm', name: 'PM', tools: 'pm' }], project: null, standing: false }), rolePrompt(role, null)]) {
      expect(p).toContain('The user reads **English**');
      expect(p).not.toContain('모든 답과 보고는 한국어로');
    }
    initServerI18n(() => 'ko', {});
    expect(poPrompt([])).toContain('한국어로 쓴다');
  });
});
