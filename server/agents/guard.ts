import { st } from '../i18n.ts';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { matchesAny } from '../util.ts';

export const WRITE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** 심볼릭 링크를 푼 실제 경로. 아직 없는 파일은 있는 조상까지 풀고 나머지를 붙인다(/var ↔ /private/var). */
export function real(p: string): string {
  let cur = normalize(p);
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try { return rest.length ? join(realpathSync(cur), ...rest.reverse()) : realpathSync(cur); } catch {
      const parent = dirname(cur);
      if (parent === cur) return normalize(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
  return normalize(p);
}

function within(root: string, p: string): boolean {
  const rel = relative(real(root), real(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function expand(p: string, cwd: string): string {
  const home = p.replace(/^~(?=$|\/)/, homedir());
  return isAbsolute(home) ? normalize(home) : resolve(cwd, home);
}

/** 쓰기 도구의 대상이 허용 루트 밖이면 거부 사유를 돌려준다. */
export function checkWritePath(tool: string, input: unknown, cwd: string, writableRoots: string[]): string | null {
  const key = WRITE_TOOLS[tool];
  if (!key) return null;
  const raw = (input as Record<string, unknown> | null)?.[key];
  if (typeof raw !== 'string' || !raw) return `${tool}: 대상 경로가 없습니다`;
  const target = expand(raw, cwd);
  if (writableRoots.some((r) => within(r, target))) return null;
  return `작업 디렉토리 밖에는 쓸 수 없습니다: ${target} (허용: ${writableRoots.join(', ')})`;
}

const SAFE_ABS = ['/dev/null', '/dev/stdout', '/dev/stderr', '/tmp/', '/private/tmp/', '/var/folders/'];

/** Bash 명령이 막을 패턴이거나 허용 루트 밖에 쓰려고 하면 거부 사유. */
export function checkBash(command: string, cwd: string, writableRoots: string[], blocked: string[]): string | null {
  const hit = matchesAny(command, blocked);
  if (hit) return `이 팀에서는 실행할 수 없는 명령입니다 (막힌 패턴: ${hit}). 승인해도 실행되지 않으니 request_approval 로 묻지 말고, 사람이 직접 실행해야 한다고 명령 전체와 함께 알려라. 커밋·푸시·운영 작업은 사람이 합니다.`;
  // 리다이렉션·tee 로 루트 밖 절대 경로에 쓰는지 대략 확인
  const re = /(?:>>?|\btee\s+(?:-a\s+)?)\s*(["']?)((?:~|\/)[^\s"';|&]+)\1/g;
  for (const m of command.matchAll(re)) {
    const p = expand(m[2]!, cwd);
    if (SAFE_ABS.some((s) => p === s.replace(/\/$/, '') || p.startsWith(s))) continue;
    if (!writableRoots.some((r) => within(r, p))) return `작업 디렉토리 밖 경로에 쓸 수 없습니다: ${p}`;
  }
  return null;
}

export function isHeavy(command: string, heavy: string[]): boolean {
  return matchesAny(command, heavy) !== null;
}

/** 도구 호출을 화면에 보여 줄 한 줄 요약. */
export function describeTool(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const short = (p: string) => p.split('/').slice(-2).join('/');
  switch (tool) {
    case 'Bash': return st('실행: {what}', { what: s(i.description) || s(i.command).slice(0, 80) });
    case 'Read': return st('읽기: {what}', { what: short(s(i.file_path)) });
    case 'Write': return st('작성: {what}', { what: short(s(i.file_path)) });
    case 'Edit': case 'MultiEdit': return st('수정: {what}', { what: short(s(i.file_path)) });
    case 'Glob': return st('파일 찾기: {what}', { what: s(i.pattern) });
    case 'Grep': return st('검색: {what}', { what: s(i.pattern).slice(0, 60) });
    case 'Agent': case 'Task': return st('{who}에게 맡김: {what}', { who: s(i.subagent_type) || st('서브에이전트'), what: s(i.description) });
    case 'TodoWrite': return st('할 일 정리');
    case 'WebFetch': return st('웹 읽기: {what}', { what: s(i.url).slice(0, 60) });
    default:
      if (tool.startsWith('mcp__hivelane__')) return tool.replace('mcp__hivelane__', 'hivelane: ');
      return tool;
  }
}
