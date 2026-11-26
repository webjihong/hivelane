/// <reference types="vite/client" />
/**
 * 화면 언어(한국어 / English). 이 기기에만 저장(테마처럼). 처음에는 서버 설정 언어(기본 영어)를 따른다.
 *
 * 쓰는 법: 한국어 문장을 그대로 키로 쓴다.
 *   t('저장했습니다')                       → 영어면 locales/en/*.ts 에서 찾은 번역, 없으면 한국어 그대로
 *   t('{n}개 팀', { n: 3 })                → 「{이름}」 자리를 값으로 바꿈
 *   tn('{b}을 누르세요', { b: <b>…</b> })  → 문장 안에 JSX 를 끼울 때(ReactNode[])
 *   locale()                               → 날짜·숫자 표시용 'ko-KR' / 'en-US'
 * 번역은 web/src/locales/en/<화면>.ts 에 { '한국어': 'English' } 로 둔다(파일마다 나눠 충돌 없이).
 */
import { Fragment, createElement, type ReactNode } from 'react';

export type Lang = 'ko' | 'en';
const KEY = 'hl-lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch { /* 저장소 없음 */ }
  // 이 기기에서 고른 적이 없으면 서버 설정 언어(맥 앱 처음 설치 화면에서 고른 것 · index.html 에 서버가 심음), 그것도 없으면 영어
  const def = typeof document !== 'undefined' ? document.documentElement.dataset.defaultLang : undefined;
  return def === 'ko' ? 'ko' : 'en';
}

export const lang: Lang = detect();

/** 언어 바꾸기: 저장하고 화면을 다시 불러온다 */
export function setLang(l: Lang): void {
  try { localStorage.setItem(KEY, l); } catch { /* 저장 안 됨 */ }
  location.reload();
}

type Dict = Record<string, string>;
const modules = import.meta.glob<{ default: Dict }>('./locales/en/*.ts', { eager: true });
const EN: Dict = lang === 'en' ? Object.assign({}, ...Object.values(modules).map((m) => m.default)) : {};

/** 테스트용: 영어 사전 전체 */
export function enDict(): Dict { return Object.assign({}, ...Object.values(modules).map((m) => m.default)); }

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

/** 같은 한국어가 화면마다 다른 뜻이면 키에 문맥을 붙인다: t('저장소@백업') → 한국어는 「저장소」, 영어는 그 키의 번역 */
const bare = (ko: string) => { const i = ko.indexOf('@'); return i > 0 ? ko.slice(0, i) : ko; };

export function t(ko: string, vars?: Record<string, string | number>): string {
  return fill(lang === 'en' ? EN[ko] ?? bare(ko) : bare(ko), vars);
}

/** 문장 안에 JSX 를 끼운다: tn('{a} 를 누르세요', { a: <b>저장</b> }) */
export function tn(ko: string, vars: Record<string, ReactNode>): ReactNode[] {
  const s = lang === 'en' ? EN[ko] ?? bare(ko) : bare(ko);
  return s.split(/(\{\w+\})/).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/);
    return createElement(Fragment, { key: i }, m && m[1]! in vars ? vars[m[1]!] : part);
  });
}

export function locale(): string { return lang === 'en' ? 'en-US' : 'ko-KR'; }

/** 요일 이름(일요일부터) */
export function weekdays(): string[] { return lang === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['일', '월', '화', '수', '목', '금', '토']; }

if (typeof document !== 'undefined') document.documentElement.lang = lang;
