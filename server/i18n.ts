/**
 * 서버가 만드는 글(알림·오류·엔진·시스템 메시지)의 언어 = 설정 › 총괄·엔진 「AI 답변·알림 언어」(settings.lang).
 * 쓰는 법은 화면과 같다: 한국어 문장을 키로 st('…', { n }) — 번역은 server/locales/en/<파일>.ts 에 { '한국어': 'English' }.
 * 저장된 기록(이미 남은 메시지)은 바꾸지 않는다. 새로 만드는 글부터 그 언어로 쓴다.
 */
import { execFileSync } from 'node:child_process';
import type { Lang } from '../shared/types.ts';

type Dict = Record<string, string>;
let EN: Dict | null = null;
let current: () => Lang = () => 'ko';

/** 서버 시작 때 한 번: 언어를 읽는 함수와 영어 사전(server/locales/en/*.ts) 연결 */
export function initServerI18n(getLang: () => Lang, dict: Dict): void { current = getLang; EN = dict; }

let macLang: string | null | undefined;
/** 맥의 시스템 언어(launchd 로 뜬 서버는 LANG 이 비어 있어 Intl 이 en-US 로 나오므로 맥 설정을 직접 읽는다) */
function readMacLang(): string | null {
  if (macLang !== undefined) return macLang;
  macLang = null;
  if (process.platform !== 'darwin' || process.env.VITEST) return macLang;
  for (const key of ['AppleLanguages', 'AppleLocale']) {
    try {
      const out = execFileSync('defaults', ['read', '-g', key], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/[a-z]{2}[-_][A-Za-z]+|[a-z]{2}/);
      if (m) { macLang = m[0]; break; }
    } catch { /* 다음 */ }
  }
  return macLang;
}

/** 맥·셸 언어로 기본값(한국어가 아니면 영어). HIVELANE_LANG > 맥 시스템 언어 > LANG > Intl */
export function systemLang(): Lang {
  const loc = (process.env.HIVELANE_LANG || readMacLang() || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'ko').toLowerCase();
  return loc.startsWith('ko') ? 'ko' : 'en';
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
