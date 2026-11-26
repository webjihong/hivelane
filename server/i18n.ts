/**
 * 서버가 만드는 글(알림·오류·엔진·시스템 메시지)의 언어 = 설정 › 총괄·엔진 「AI 답변·알림 언어」(settings.lang).
 * 쓰는 법은 화면과 같다: 한국어 문장을 키로 st('…', { n }) — 번역은 server/locales/en/<파일>.ts 에 { '한국어': 'English' }.
 * 저장된 기록(이미 남은 메시지)은 바꾸지 않는다. 새로 만드는 글부터 그 언어로 쓴다.
 */
import type { Lang } from '../shared/types.ts';

type Dict = Record<string, string>;
let EN: Dict | null = null;
let current: () => Lang = () => 'ko';

/** 서버 시작 때 한 번: 언어를 읽는 함수와 영어 사전(server/locales/en/*.ts) 연결 */
export function initServerI18n(getLang: () => Lang, dict: Dict): void { current = getLang; EN = dict; }

/**
 * 설정에 언어가 아직 저장되지 않았을 때의 기본값: HIVELANE_LANG(맥 앱이 처음 설치 화면에서 고른 언어를 넘긴다) > 영어.
 * 한 번이라도 설정을 저장하면 그 값(settings.lang)이 이긴다.
 */
export function systemLang(): Lang {
  return process.env.HIVELANE_LANG?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function serverLang(): Lang { try { return current(); } catch { return 'ko'; } }

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

export function st(ko: string, vars?: Record<string, string | number>): string {
  return fill(serverLang() === 'en' ? EN?.[ko] ?? ko : ko, vars);
}

/** 서버가 만든 선택지(st 로 번역된 것)와 사람이 보낸 답 비교 — 한국어 원문이든 영어 번역이든 같은 선택지로 본다 */
export function isOpt(answer: string, ko: string): boolean {
  const a = answer.trim();
  return a === ko || (!!EN?.[ko] && a.toLowerCase() === EN[ko]!.toLowerCase());
}
