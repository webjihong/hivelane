import { afterEach, describe, expect, it } from 'vitest';
import { withLang } from '../server/http/app.ts';
import { systemLang } from '../server/i18n.ts';

describe('기본 언어', () => {
  const saved = process.env.HIVELANE_LANG;
  afterEach(() => { if (saved === undefined) delete process.env.HIVELANE_LANG; else process.env.HIVELANE_LANG = saved; });

  it('설정에 언어가 없으면 HIVELANE_LANG(맥 앱 처음 설치 화면에서 고른 것), 없으면 영어', () => {
    delete process.env.HIVELANE_LANG;
    expect(systemLang()).toBe('en');
    process.env.HIVELANE_LANG = 'ko';
    expect(systemLang()).toBe('ko');
    process.env.HIVELANE_LANG = 'fr';
    expect(systemLang()).toBe('en');
  });

  it('index.html 에 설정 언어를 심는다(화면은 기기에 고른 언어가 없으면 이걸 따른다)', () => {
    const html = '<!doctype html>\n<html lang="en">\n<head></head></html>';
    expect(withLang(html, 'ko')).toContain('<html lang="ko" data-default-lang="ko">');
    expect(withLang(html, 'en')).toContain('<html lang="en" data-default-lang="en">');
  });
});
