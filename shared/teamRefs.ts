/**
 * 글 속 팀 id(tm-…, s-…)를 팀 이름과 함께 보이게 한다. 화면(칩)과 서버(알림 글) 가 함께 쓴다.
 * - 이미 「이름(id)」·「이름 (id)」로 쓴 곳은 이름을 한 번만.
 * - 모르는 id 는 그대로.
 * - ``` 코드 블록 안은 건드리지 않는다(withTeamNames). 화면은 코드 블록을 따로 그려서 여기까지 오지 않는다.
 */
export interface TeamName { name: string }
export type TeamRef = { id: string; name: string };
export type Lookup = (id: string) => TeamName | undefined;

/** 팀 id 모양: tm-xxxxxxxxx(업무 팀) · s-xxxxxxxxx(직속 팀) */
export const TEAM_ID_RE = /(?<![\w-])(?:tm|s)-[a-z0-9]{6,12}(?![\w-])/g;

/** 글을 「문자열 / 팀 참조」 조각으로 나눈다. 앞에 이름이 이미 있으면 「이름(id)」 전체를 참조 하나로 바꾼다. */
export function splitTeamRefs(text: string, lookup: Lookup): (string | TeamRef)[] {
  const out: (string | TeamRef)[] = [];
  let pos = 0;
  for (const m of text.matchAll(TEAM_ID_RE)) {
    const id = m[0];
    const t = lookup(id);
    if (!t) continue;
    let start = m.index!;
    let end = start + id.length;
    // 「이름(id)」·「이름 (id)」·「이름 · id」 → 이름을 한 번만
    const before = text.slice(pos, start);
    const name = t.name.trim();
    const paren = before.match(/\s?\(\s*$/);
    if (paren && text[end] === ')' && name && before.slice(0, paren.index).endsWith(name)) {
      start = pos + paren.index! - name.length;
      end += 1;
    } else {
      const dot = before.match(/\s*[·:]\s*$/);
      if (dot && name && before.slice(0, dot.index).endsWith(name)) start = pos + dot.index! - name.length;
    }
    if (start > pos) out.push(text.slice(pos, start));
    out.push({ id, name });
    pos = end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out.length ? out : [text];
}

/** 일반 글(알림 등)용: 팀 id → 「이름(id)」. ``` 코드 블록 안은 그대로 */
export function withTeamNames(text: string, lookup: Lookup): string {
  return text.split(/(```[\s\S]*?(?:```|$))/).map((part) => (part.startsWith('```') ? part : splitTeamRefs(part, lookup).map((p) => (typeof p === 'string' ? p : `${p.name}(${p.id})`)).join(''))).join('');
}

/** 긴 업무 제목은 줄여서(전체는 툴팁) */
export function shortName(name: string, max = 22): string {
  const s = name.trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
