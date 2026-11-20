import { homedir } from 'node:os';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { matchesAny } from '../util.ts';

export const WRITE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

function within(root: string, p: string): boolean {
  const rel = relative(normalize(root), normalize(p));
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
  if (hit) return `이 팀에서는 실행할 수 없는 명령입니다 (막힌 패턴: ${hit}). 커밋·푸시·운영 작업은 사람이 합니다.`;
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
    case 'Bash': return `실행: ${s(i.description) || s(i.command).slice(0, 80)}`;
    case 'Read': return `읽기: ${short(s(i.file_path))}`;
    case 'Write': return `작성: ${short(s(i.file_path))}`;
    case 'Edit': case 'MultiEdit': return `수정: ${short(s(i.file_path))}`;
    case 'Glob': return `파일 찾기: ${s(i.pattern)}`;
    case 'Grep': return `검색: ${s(i.pattern).slice(0, 60)}`;
    case 'Agent': case 'Task': return `${s(i.subagent_type) || '서브에이전트'}에게 맡김: ${s(i.description)}`;
    case 'TodoWrite': return '할 일 정리';
    case 'WebFetch': return `웹 읽기: ${s(i.url).slice(0, 60)}`;
    default:
      if (tool.startsWith('mcp__hivelane__')) return tool.replace('mcp__hivelane__', 'hivelane: ');
      return tool;
  }
}
