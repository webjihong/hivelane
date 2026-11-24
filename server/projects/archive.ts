import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AppConfig } from '../config.ts';
import { run } from '../util.ts';

const git = (cwd: string, args: string[], timeoutMs = 120_000) => run('git', ['-C', cwd, ...args], { timeoutMs });

export function archiveDir(cfg: AppConfig): string { return join(cfg.home, 'archive'); }

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 80);

/**
 * 지우기 직전 worktree 의 변경을 패치로 남긴다: 기준 커밋(없으면 HEAD) 대비 커밋한 것 + 커밋 안 한 것 + 새 파일(무시 목록 제외).
 * 변경이 없으면 null. 결과 파일은 `git apply` 로 되살릴 수 있다.
 */
export async function saveWorktreePatch(cfg: AppConfig, wt: string, base: string | null, key: string): Promise<{ path: string; files: number } | null> {
  if (!existsSync(wt)) return null;
  await git(wt, ['add', '-A', '-N', '--', '.']); // 새 파일도 diff 에 보이게(지울 폴더라 index 를 건드려도 된다)
  const dir = archiveDir(cfg);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${safe(key)}-${stamp()}.patch`);
  const r = await git(wt, ['diff', '--binary', '-M', `--output=${out}`, base ?? 'HEAD']);
  if (r.code !== 0 || !existsSync(out) || statSync(out).size === 0) return null;
  const files = (readFileSync(out, 'utf8').match(/^diff --git /gm) ?? []).length;
  return { path: out, files };
}

/** 지우기 직전 브랜치의 고유 커밋을 패치(git log -p)로 남긴다. 고유 커밋이 없으면 null */
export async function saveBranchPatch(cfg: AppConfig, root: string, branch: string, base: string): Promise<{ path: string; files: number; sha: string } | null> {
  const sha = (await git(root, ['rev-parse', branch])).stdout.trim();
  const dir = archiveDir(cfg);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `branch-${safe(branch)}-${stamp()}.patch`);
  const r = await git(root, ['log', '-p', '--binary', `--output=${out}`, `${base}..${branch}`]);
  if (r.code !== 0 || !existsSync(out) || statSync(out).size === 0) return sha ? { path: '', files: 0, sha } : null;
  const files = (readFileSync(out, 'utf8').match(/^diff --git /gm) ?? []).length;
  return { path: out, files, sha };
}

/** 패치 읽기(경로를 주면 그 파일 부분만) */
export function readPatch(path: string, file?: string, maxBytes = 400_000): string {
  if (!path || !existsSync(path)) return '';
  let s = readFileSync(path, 'utf8');
  if (file) s = s.split(/(?=^diff --git )/m).filter((part) => part.startsWith('diff --git ') && (part.includes(` a/${file}\n`) || part.includes(` b/${file}\n`) || part.split('\n')[0]!.endsWith(` b/${file}`))).join('');
  return s.length > maxBytes ? s.slice(0, maxBytes) + '\n… (잘림)' : s;
}

export const patchName = (p: string) => basename(p);
