/**
 * 화면 테마·글자 크기(이 기기에만 저장). 화면 구조는 그대로, CSS 변수 값만 바꾼다.
 * - 본문: --bg --surface --surface-2 --line --fg --muted --accent --accent-soft (+ 상태색)
 * - 사이드바: --sb-bg --sb-fg --sb-muted --sb-dim --sb-strong --sb-hover --sb-on --sb-line --sb-amber --sb-good --sb-warn --sb-crit
 */
import { t } from './i18n.ts';

export interface Theme { id: string; name: string; desc: string; scheme: 'light' | 'dark' | 'system'; vars: Record<string, string>; font?: string; scale?: Partial<Record<AreaKey, number>>; custom?: boolean }

type Main = { bg: string; surface: string; surface2: string; line: string; fg: string; muted: string; accent: string; good?: string; warn?: string; crit?: string };
type Side = { bg: string; fg: string; muted: string; dim: string; hover: string; on: string; line: string; amber: string; good?: string; warn?: string; crit?: string; strong?: string };

const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

function make(id: string, name: string, desc: string, scheme: 'light' | 'dark', m: Main, sb: Side): Theme {
  const soft = scheme === 'dark' ? 0.15 : 0.11;
  const v: Record<string, string> = {
    '--bg': m.bg, '--surface': m.surface, '--surface-2': m.surface2, '--line': m.line, '--fg': m.fg, '--muted': m.muted,
    '--accent': m.accent, '--accent-soft': rgba(m.accent, scheme === 'dark' ? 0.16 : 0.1),
    '--sb-bg': sb.bg, '--sb-fg': sb.fg, '--sb-muted': sb.muted, '--sb-dim': sb.dim, '--sb-hover': sb.hover, '--sb-on': sb.on, '--sb-line': sb.line,
    '--sb-amber': sb.amber, '--sb-strong': sb.strong ?? '#FFFFFF',
  };
  if (m.good) { v['--good'] = m.good; v['--good-soft'] = rgba(m.good, soft); }
  if (m.warn) { v['--warn'] = m.warn; v['--warn-soft'] = rgba(m.warn, soft); }
  if (m.crit) { v['--crit'] = m.crit; v['--crit-soft'] = rgba(m.crit, soft); }
  if (sb.good) v['--sb-good'] = sb.good;
  if (sb.warn) v['--sb-warn'] = sb.warn;
  if (sb.crit) v['--sb-crit'] = sb.crit;
  return { id, name, desc, scheme, vars: v };
}

export const THEMES: Theme[] = [
  { id: 'default', name: t('숲 관제실'), desc: t('기본 · 맥의 밝게/어둡게 설정을 따라감'), scheme: 'system', vars: {} },
  make('dawn-mist', t('새벽 안개'), t('차분한 회청색 · 밝음'), 'light',
    { bg: '#EEF2F6', surface: '#FFFFFF', surface2: '#E4EAF0', line: '#CCD5DF', fg: '#18222E', muted: '#5B6878', accent: '#3B6FD8' },
    { bg: '#1E2A3A', fg: '#DCE3EC', muted: '#8E9BB0', dim: '#A7B4C7', hover: '#27364A', on: '#31445E', line: '#2C3B50', amber: '#F2B33D', good: '#4CC58A' }),
  make('paper-ink', t('종이와 먹'), t('따뜻한 한지 바탕 · 먹색 글씨'), 'light',
    { bg: '#F5F1E8', surface: '#FFFDF8', surface2: '#ECE6D9', line: '#D9D0BF', fg: '#1F1B16', muted: '#6B6255', accent: '#2F4858' },
    { bg: '#2A2622', fg: '#EDE6DA', muted: '#A69C8C', dim: '#C2B8A8', hover: '#35302A', on: '#443D35', line: '#3D372F', amber: '#E0A84A', good: '#6CC08B', warn: '#E2B86A', crit: '#E07A5F' }),
  make('cherry', t('벚꽃길'), t('연분홍 · 밝음'), 'light',
    { bg: '#FBF3F5', surface: '#FFFFFF', surface2: '#F5E7EB', line: '#EBD3DA', fg: '#2A1A20', muted: '#7A5F68', accent: '#C2477A' },
    { bg: '#3B2230', fg: '#F5E4EB', muted: '#C49AAE', dim: '#DDB9C8', hover: '#4A2C3C', on: '#5C3649', line: '#523042', amber: '#F4B860', good: '#6FD39B' }),
  make('sea-breeze', t('바닷바람'), t('맑은 바다색 · 밝음'), 'light',
    { bg: '#EEF6F8', surface: '#FFFFFF', surface2: '#E0EEF2', line: '#C7DCE3', fg: '#10232B', muted: '#4F6A74', accent: '#0A7FA8' },
    { bg: '#0E3A4A', fg: '#DDF0F5', muted: '#86B4C2', dim: '#A9CFDA', hover: '#134858', on: '#1A5A6D', line: '#1A4D5E', amber: '#F5C04E', good: '#56D69A' }),
  make('dune', t('모래 언덕'), t('모래빛 바탕 · 테라코타 강조'), 'light',
    { bg: '#F7F1EA', surface: '#FFFFFF', surface2: '#EFE5D9', line: '#E0D2C1', fg: '#2B2118', muted: '#75665A', accent: '#B5562F' },
    { bg: '#3E2C21', fg: '#F3E7DA', muted: '#BFA58F', dim: '#D6C0AC', hover: '#4B372A', on: '#5C4434', line: '#4F3A2C', amber: '#F0B35A', good: '#7CCB8F' }),
  make('night-control', t('한밤 관제실'), t('짙은 남색 · 하늘색 강조 · 어두움'), 'dark',
    { bg: '#0B1220', surface: '#111A2B', surface2: '#172338', line: '#24324A', fg: '#E3EAF5', muted: '#8E9AB2', accent: '#38BDF8', good: '#4ADE80', warn: '#FBBF24', crit: '#F87171' },
    { bg: '#070D18', fg: '#D6DEEB', muted: '#7C89A3', dim: '#9FB0CC', hover: '#121C2E', on: '#1A2840', line: '#1A2538', amber: '#FBBF24', good: '#4ADE80', warn: '#FBBF24', crit: '#F87171' }),
  make('storm', t('먹구름'), t('무채색 회색 · 어두움'), 'dark',
    { bg: '#17181A', surface: '#1F2023', surface2: '#27292D', line: '#34373C', fg: '#E6E6E6', muted: '#9A9DA3', accent: '#8AB4F8' },
    { bg: '#111214', fg: '#DADBDD', muted: '#8B8E94', dim: '#A8ABB1', hover: '#1C1D20', on: '#2A2C30', line: '#26282C', amber: '#F2B33D' }),
  make('cabin', t('숲속 오두막'), t('짙은 숲색 · 호박색 강조 · 어두움'), 'dark',
    { bg: '#111A15', surface: '#17231C', surface2: '#1E2D24', line: '#2B3E32', fg: '#E4EDE6', muted: '#93A89A', accent: '#E0A84A', good: '#6CC08B', warn: '#E9C46A', crit: '#E9705F' },
    { bg: '#0C140F', fg: '#DCE7DF', muted: '#86A08E', dim: '#A9C2B0', hover: '#16231B', on: '#213428', line: '#1C2B21', amber: '#E0A84A', good: '#6CC08B' }),
  make('sunset-sea', t('노을 바다'), t('보랏빛 밤 · 주황 강조 · 어두움'), 'dark',
    { bg: '#17121F', surface: '#1F1829', surface2: '#281F35', line: '#392D4A', fg: '#EEE6F5', muted: '#A496B5', accent: '#FF8A5B' },
    { bg: '#120D19', fg: '#E6DDF0', muted: '#9A8CAE', dim: '#BBA9D0', hover: '#1E1629', on: '#2D2140', line: '#231A31', amber: '#FFB454' }),
  make('clear', t('또렷하게'), t('고대비 · 글씨가 가장 잘 보임'), 'light',
    { bg: '#FFFFFF', surface: '#FFFFFF', surface2: '#F0F0F0', line: '#767676', fg: '#000000', muted: '#333333', accent: '#0040C0', good: '#006B2D', warn: '#8A5200', crit: '#B00020' },
    { bg: '#000000', fg: '#FFFFFF', muted: '#D0D0D0', dim: '#E6E6E6', hover: '#222222', on: '#333333', line: '#555555', amber: '#FFD000', good: '#00E07A', warn: '#FFD000', crit: '#FF5A5A' }),
];

/** 나만의 테마에서 고칠 수 있는 색(변수 이름 · 이름 · 묶음) — 연한 색(-soft)은 저장할 때 자동으로 만든다 */
export const TOKENS: { v: string; label: string; group: '본문' | '왼쪽 목록' | '상태' }[] = [
  { v: '--bg', label: t('바탕'), group: '본문' },
  { v: '--surface', label: t('카드·입력칸'), group: '본문' },
  { v: '--surface-2', label: t('카드 안쪽·흐린 칸'), group: '본문' },
  { v: '--line', label: t('테두리·구분선'), group: '본문' },
  { v: '--fg', label: t('글씨'), group: '본문' },
  { v: '--muted', label: t('흐린 글씨'), group: '본문' },
  { v: '--accent', label: t('강조(버튼·링크)'), group: '본문' },
  { v: '--sb-bg', label: t('바탕'), group: '왼쪽 목록' },
  { v: '--sb-fg', label: t('글씨'), group: '왼쪽 목록' },
  { v: '--sb-dim', label: t('보조 글씨'), group: '왼쪽 목록' },
  { v: '--sb-muted', label: t('흐린 글씨'), group: '왼쪽 목록' },
  { v: '--sb-hover', label: t('마우스 올림'), group: '왼쪽 목록' },
  { v: '--sb-on', label: t('선택된 항목'), group: '왼쪽 목록' },
  { v: '--sb-line', label: t('구분선'), group: '왼쪽 목록' },
  { v: '--sb-amber', label: t('강조(지금 볼 것·배지)'), group: '왼쪽 목록' },
  { v: '--good', label: t('좋음(완료·초록)'), group: '상태' },
  { v: '--warn', label: t('주의(노랑)'), group: '상태' },
  { v: '--crit', label: t('위험(실패·빨강)'), group: '상태' },
];

/** 글꼴 고르기 */
export const FONTS: { id: string; label: string; css: string }[] = [
  { id: '', label: t('기본 (IBM Plex Sans KR)'), css: '' },
  { id: 'apple', label: t('Apple SD 산돌고딕 Neo'), css: '"Apple SD Gothic Neo", system-ui, sans-serif' },
  { id: 'system', label: t('시스템 글꼴'), css: 'system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif' },
  { id: 'nanum', label: t('나눔고딕(설치돼 있으면)'), css: '"NanumGothic", "Nanum Gothic", "Apple SD Gothic Neo", sans-serif' },
  { id: 'mono', label: t('고정폭(코딩 글꼴)'), css: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, "Apple SD Gothic Neo", monospace' },
];

/** 색 값들 → 테마 변수(연한 색은 자동으로) */
export function varsFromTokens(scheme: 'light' | 'dark', tok: Record<string, string>): Record<string, string> {
  const v: Record<string, string> = { ...tok };
  const a = scheme === 'dark' ? 0.16 : 0.1;
  const soft = scheme === 'dark' ? 0.15 : 0.11;
  if (tok['--accent']) v['--accent-soft'] = rgba(tok['--accent'], a);
  for (const k of ['--good', '--warn', '--crit']) if (tok[k]) v[`${k}-soft`] = rgba(tok[k], soft);
  if (tok['--good']) v['--sb-good'] = tok['--good'];
  if (tok['--warn']) v['--sb-warn'] = tok['--warn'];
  if (tok['--crit']) v['--sb-crit'] = tok['--crit'];
  v['--sb-strong'] = scheme === 'dark' || isDark(tok['--sb-bg'] ?? '#000000') ? '#FFFFFF' : '#000000';
  return v;
}
const isDark = (hex: string) => { const n = parseInt(hex.replace('#', '').slice(0, 6), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return 0.299 * r + 0.587 * g + 0.114 * b < 140; };

/** 지금 화면에 실제로 입혀진 색(테마 변수 또는 기본 CSS) → #RRGGBB */
export function currentTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const tk of TOKENS) out[tk.v] = toHex(cs.getPropertyValue(tk.v).trim());
  return out;
}
function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`.toUpperCase();
  const m = c.match(/rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  return m ? `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`.toUpperCase() : '#888888';
}

/** 글자 크기를 바꿀 수 있는 화면 영역 */
export const AREAS = [
  { key: 'sb', label: t('왼쪽 목록'), desc: t('채널·팀·저장소·상태줄') },
  { key: 'page', label: t('페이지'), desc: t('지금 볼 것·PR·스크립트·설정·끝난 팀') },
  { key: 'chat', label: t('대화'), desc: t('총괄·팀 채널의 말풍선과 기록') },
  { key: 'input', label: t('입력칸'), desc: t('지시·답장 쓰는 칸') },
] as const;
export type AreaKey = (typeof AREAS)[number]['key'];
export const SCALES = [0.85, 0.9, 1, 1.1, 1.2, 1.35, 1.5];

export interface UiPrefs { theme: string; scale: Partial<Record<AreaKey, number>>; custom?: Theme[] }

/** 기본 프리셋 + 나만의 테마 */
export const allThemes = (p: UiPrefs): Theme[] => [...THEMES, ...(p.custom ?? [])];
const KEY = 'hl.ui';

export function loadPrefs(): UiPrefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '') as UiPrefs; if (v && typeof v.theme === 'string') return { theme: v.theme, scale: v.scale ?? {}, custom: Array.isArray(v.custom) ? v.custom : [] }; } catch { /* 없음 */ }
  return { theme: 'default', scale: {}, custom: [] };
}

let applied: string[] = [];
/** 테마·글자 크기를 문서에 입힌다 */
export function applyPrefs(p: UiPrefs): void {
  const root = document.documentElement;
  for (const k of applied) root.style.removeProperty(k);
  const th = allThemes(p).find((x) => x.id === p.theme) ?? THEMES[0]!;
  if (th.scheme === 'system') delete root.dataset.theme; else root.dataset.theme = th.scheme;
  applied = Object.keys(th.vars);
  for (const [k, v] of Object.entries(th.vars)) root.style.setProperty(k, v);
  const font = FONTS.find((f) => f.id === th.font)?.css;
  if (font) { root.style.setProperty('--font-body', font); applied.push('--font-body'); }
  for (const a of AREAS) {
    const z = p.scale[a.key];
    if (z && z !== 1) { root.style.setProperty(`--z-${a.key}`, String(z)); applied.push(`--z-${a.key}`); }
  }
  // 휴대폰 상단 막대 색: 테마를 고르면 그 바탕색, 기본이면 원래 값
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const el = m as HTMLMetaElement;
    el.dataset.orig ??= el.content;
    el.content = th.vars['--surface'] ?? el.dataset.orig ?? el.content;
  });
}

export function savePrefs(p: UiPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 저장 안 됨 */ }
  applyPrefs(p);
}
