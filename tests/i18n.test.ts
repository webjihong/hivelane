import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const HANGUL = /[가-힣]/;

/** 파일에서 t('…')·tn('…') 의 첫 인자(문자열 그대로 쓴 것만) */
function keysIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:t|tn|st)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]!.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1'));
  return out.filter((k) => HANGUL.test(k) && !k.includes('${'));
}

async function dict(dir: string, skip: string[] = []): Promise<Record<string, string>> {
  const all: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !skip.includes(x))) Object.assign(all, (await import(join(dir, f))).default);
  return all;
}

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('영어 번역', () => {
  it('화면의 t()/tn() 문구는 모두 영어가 있고, {자리표시}가 같다', async () => {
    const en = await dict(join(ROOT, 'web/src/locales/en'));
    const dir = join(ROOT, 'web/src');
    const missing: string[] = [];
    const badHoles: string[] = [];
    for (const f of readdirSync(dir).filter((x) => /\.(ts|tsx)$/.test(x) && x !== 'i18n.ts')) { // i18n.ts 는 주석 속 예시뿐
      for (const k of keysIn(readFileSync(join(dir, f), 'utf8'))) {
        if (!(k in en)) missing.push(`${f}: ${k}`);
        else if (JSON.stringify(holes(k)) !== JSON.stringify(holes(en[k]!))) badHoles.push(`${f}: ${k} → ${en[k]}`);
      }
    }
    expect(missing).toEqual([]);
    expect(badHoles).toEqual([]);
  });

  it('영어 사전 값에 한국어가 남아 있지 않다', async () => {
    const en = await dict(join(ROOT, 'web/src/locales/en'));
    expect(Object.entries(en).filter(([, v]) => HANGUL.test(v)).map(([k]) => k)).toEqual([]);
  });
});
