/** 프로토타입의 그림 조각(로봇 작업자·기어·출하 상자). 모두 SVG 문자열을 만든다 — 사용자 글은 반드시 esc() 를 거친다. */
import type { Model } from '../../shared/types.ts';

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export const MODEL_LABEL: Record<Model, 'Opus' | 'Sonnet' | 'Haiku'> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

export type ToolKind = 'PM' | '개발' | 'QA' | '탐색' | '리뷰어';

/** 역할 키·이름으로 손에 든 도구를 고른다. */
export function toolKind(roleKey: string, roleName: string, preset?: string): ToolKind {
  const k = `${roleKey} ${roleName}`.toLowerCase();
  if (roleKey === 'pm' || preset === 'pm') return 'PM';
  if (/qa|검사|테스트/.test(k) || preset === 'verify') return 'QA';
  if (/review|리뷰/.test(k)) return '리뷰어';
  if (/explore|research|탐색|조사/.test(k) || preset === 'read') return '탐색';
  return '개발';
}

export const GEAR = '<svg class="gear" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.3 1.5h3.4l.5 2.6a8 8 0 0 1 2 1.1l2.5-.9 1.7 2.9-2 1.8a8 8 0 0 1 0 2.3l2 1.8-1.7 2.9-2.5-.9a8 8 0 0 1-2 1.1l-.5 2.6h-3.4l-.5-2.6a8 8 0 0 1-2-1.1l-2.5.9-1.7-2.9 2-1.8a8 8 0 0 1 0-2.3l-2-1.8 1.7-2.9 2.5.9a8 8 0 0 1 2-1.1zM12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z"/></svg>';

export function binSvg(done: boolean): string {
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 18h32l-3 18H7z" fill="none" stroke="currentColor" stroke-width="1.6"/>${done ? '<rect x="9" y="8" width="10" height="10" rx="1.5" fill="currentColor" opacity=".55"/><rect x="21" y="8" width="10" height="10" rx="1.5" fill="currentColor" opacity=".8"/><rect x="15" y="0" width="10" height="9" rx="1.5" fill="currentColor"/>' : ''}</svg>`;
}

/** 모델별 로봇: Opus = 안전모 큰 로봇, Sonnet = 안테나 둥근 로봇, Haiku = 외눈 소형 로봇. 역할별 도구를 든다. */
export function avatar(model: Model, tool: ToolKind, label: string, cls = ''): string {
  const name = MODEL_LABEL[model];
  const c = `var(--m-${model})`;
  const face = 'var(--surface)';
  let head: string;
  if (name === 'Opus') head = `<rect x="14" y="20" width="36" height="30" rx="8" fill="${c}"/><path d="M11 22a21 14 0 0 1 42 0z" fill="${c}"/><rect x="9" y="20" width="46" height="4" rx="2" fill="${c}"/><path d="M32 9v9" stroke="${face}" stroke-width="2" opacity=".6"/><rect x="20" y="30" width="24" height="10" rx="5" fill="${face}"/><circle cx="26" cy="35" r="2.6" fill="${c}"/><circle cx="38" cy="35" r="2.6" fill="${c}"/>`;
  else if (name === 'Sonnet') head = `<line x1="32" y1="8" x2="32" y2="16" stroke="${c}" stroke-width="2.2"/><circle cx="32" cy="7" r="3.2" fill="${c}"/><circle cx="32" cy="34" r="17" fill="${c}"/><rect x="21" y="28" width="22" height="11" rx="5.5" fill="${face}"/><circle cx="27" cy="33.5" r="2.6" fill="${c}"/><circle cx="37" cy="33.5" r="2.6" fill="${c}"/><rect x="12" y="31" width="4" height="7" rx="2" fill="${c}"/><rect x="48" y="31" width="4" height="7" rx="2" fill="${c}"/>`;
  else head = `<rect x="19" y="22" width="26" height="24" rx="7" fill="${c}"/><circle cx="32" cy="36" r="6" fill="${face}"/><circle cx="32" cy="36" r="3" fill="${c}"/><path d="M24 22l-3-6M40 22l3-6" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`;
  const labelY = { Opus: 28.6, Sonnet: 25, Haiku: 28 }[name];
  head += `<text x="32" y="${labelY}" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, monospace" font-size="${name === 'Haiku' ? 5 : 5.6}" font-weight="700" letter-spacing=".2" fill="${face}">${name}</text>`;
  const body = `<rect x="20" y="49" width="24" height="13" rx="4" fill="${c}" opacity=".85"/>`;
  const tools: Record<ToolKind, string> = {
    PM: `<rect x="44" y="44" width="13" height="17" rx="2" fill="${face}" stroke="${c}" stroke-width="1.6"/><rect x="47" y="42" width="7" height="4" rx="1" fill="${c}"/><path d="M47 51h7M47 55h5" stroke="${c}" stroke-width="1.4"/>`,
    '개발': `<path d="M46 60l9-11" stroke="${c}" stroke-width="3" stroke-linecap="round"/><path d="M52 44a5 5 0 1 0 6 6l-3-1-1-3z" fill="${c}"/>`,
    QA: `<circle cx="51" cy="48" r="6" fill="${face}" stroke="${c}" stroke-width="2"/><path d="M47 52l-5 7" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`,
    '탐색': `<rect x="44" y="47" width="13" height="7" rx="2" fill="${c}"/><path d="M57 47l5-3v13l-5-3z" fill="${c}" opacity=".6"/>`,
    '리뷰어': `<circle cx="47" cy="50" r="4" fill="none" stroke="${c}" stroke-width="2"/><circle cx="56" cy="50" r="4" fill="none" stroke="${c}" stroke-width="2"/><path d="M51 50h1" stroke="${c}" stroke-width="2"/>`,
  };
  return `<svg viewBox="0 0 64 64" class="${esc(cls)}" role="img" aria-label="${esc(`${name} ${label} 로봇`)}">${head}${body}<g class="tool">${tools[tool]}</g></svg>`;
}
