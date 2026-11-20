import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { logger } from '../log.ts';
import { run, type ExecResult } from '../util.ts';

const log = logger('git');

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return run('git', ['-C', cwd, ...args], { timeoutMs });
}
async function gitOk(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await git(cwd, args, timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} 실패: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export interface RepoInfo { root: string; name: string; baseRef: string; memoryPaths: string[] }

/** 경로가 git 저장소인지 확인하고 기본값을 추정한다. */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  const abs = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`폴더가 없습니다: ${abs}`);
  const root = await gitOk(abs, ['rev-parse', '--show-toplevel']).catch(() => { throw new Error(`git 저장소가 아닙니다: ${abs}`); });
  let baseRef = '';
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.stdout.trim()) baseRef = head.stdout.trim();
  if (!baseRef) {
    const cur = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = cur.stdout.trim() || 'main';
    const remote = await git(root, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
    baseRef = remote.code === 0 ? `origin/${branch}` : branch;
  }
  // Claude Code 자동 메모리는 경로를 '-' 로 바꾼 폴더에 있다.
  const memDir = join(homedir(), '.claude', 'projects', root.replace(/[/.]/g, '-'), 'memory');
  return { root, name: basename(root), baseRef, memoryPaths: existsSync(memDir) ? [memDir] : [] };
}

export async function resolveRef(root: string, ref: string): Promise<string> {
  return gitOk(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/** origin/<branch> 이면 그 브랜치만 fetch. 네트워크 실패는 경고만 남기고 지금 있는 ref 로 진행. */
export async function fetchBase(root: string, baseRef: string): Promise<void> {
  const m = baseRef.match(/^([^/]+)\/(.+)$/);
  if (!m) return;
  const [, remote, branch] = m;
  const remotes = await git(root, ['remote']);
  if (!remotes.stdout.split('\n').includes(remote!)) return;
  const r = await git(root, ['fetch', '--quiet', remote!, branch!], 90_000);
  if (r.code !== 0) log.warn(`fetch 실패, 로컬 ${baseRef} 로 진행`, r.stderr.trim());
}

export interface WorktreeResult { path: string; branch: string; baseSha: string }

export async function addWorktree(root: string, baseRef: string, dir: string, branch: string): Promise<WorktreeResult> {
  await fetchBase(root, baseRef);
  const baseSha = await resolveRef(root, baseRef);
  mkdirSync(dirname(dir), { recursive: true });
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (existsSync(dir)) throw new Error(`worktree 경로가 이미 있습니다: ${dir}`);
  if (exists.code === 0) await gitOk(root, ['worktree', 'add', dir, branch]);
  else await gitOk(root, ['worktree', 'add', '-b', branch, dir, baseSha]);
  return { path: dir, branch, baseSha };
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  if (!existsSync(dir)) { await git(root, ['worktree', 'prune']); return; }
  await gitOk(root, ['worktree', 'remove', '--force', dir]);
}

/** 패키지 디렉토리(package.json 이 있는 곳) 목록. git 이 추적하는 것만. */
async function packageDirs(wt: string): Promise<string[]> {
  const out = await gitOk(wt, ['ls-files', '--', 'package.json', '**/package.json']);
  return out.split('\n').filter(Boolean).filter((p) => !p.includes('node_modules/')).map((p) => dirname(p));
}

const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
function lockOf(dir: string): string | null {
  for (const l of LOCKS) { const p = join(dir, l); if (existsSync(p)) return readFileSync(p, 'utf8'); }
  return null;
}

export interface DepsReport { linked: string[]; installed: string[]; skipped: string[]; failed: { dir: string; error: string }[] }

/**
 * 의존성 준비.
 * - symlink: 메인 트리 node_modules 를 링크. lock 파일이 다르면 그 디렉토리만 설치.
 * - install: 모든 패키지 디렉토리에서 설치.
 */
export async function prepareDeps(mainRoot: string, wt: string, strategy: 'symlink' | 'install' | 'none'): Promise<DepsReport> {
  const rep: DepsReport = { linked: [], installed: [], skipped: [], failed: [] };
  if (strategy === 'none') return rep;
  for (const rel of await packageDirs(wt)) {
    const src = join(mainRoot, rel, 'node_modules');
    const dst = join(wt, rel, 'node_modules');
    if (existsSync(dst) || isLink(dst)) { rep.skipped.push(rel || '.'); continue; }
    const sameLock = lockOf(join(mainRoot, rel)) === lockOf(join(wt, rel));
    if (strategy === 'symlink' && sameLock && existsSync(src)) {
      symlinkSync(src, dst, 'dir');
      rep.linked.push(rel || '.');
      continue;
    }
    if (!lockOf(join(wt, rel))) { rep.skipped.push(rel || '.'); continue; }
    const r = await run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: join(wt, rel), timeoutMs: 15 * 60_000 });
    if (r.code === 0) rep.installed.push(rel || '.');
    else rep.failed.push({ dir: rel || '.', error: r.stderr.slice(-500) });
  }
  return rep;
}
function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

export interface ChangeRow { path: string; change_type: string; lines_added: number; lines_removed: number }

/** base 커밋 대비 지금 worktree 의 변경(커밋된 것 + 안 된 것 + 새 파일). node_modules 링크는 제외. */
export async function collectChanges(wt: string, baseSha: string): Promise<ChangeRow[]> {
  const [num, status, untracked] = await Promise.all([
    git(wt, ['diff', '--numstat', '-M', baseSha]),
    git(wt, ['diff', '--name-status', '-M', baseSha]),
    git(wt, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const types = new Map<string, string>();
  for (const line of status.stdout.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const path = parts[parts.length - 1] ?? '';
    types.set(path, code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified');
  }
  const rows: ChangeRow[] = [];
  for (const line of num.stdout.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = line.split('\t');
    let path = rest.join('\t');
    const arrow = path.match(/\{.* => (.*)\}|.* => (.*)/);
    if (arrow) path = path.replace(/\{(.*) => (.*)\}/, '$2').replace(/^.* => /, '');
    rows.push({ path, change_type: types.get(path) ?? 'modified', lines_added: Number(a) || 0, lines_removed: Number(d) || 0 });
  }
  for (const p of untracked.stdout.split('\n').filter(Boolean)) {
    if (p.endsWith('node_modules') || p.includes('node_modules/')) continue;
    let lines = 0;
    try { const s = statSync(join(wt, p)); if (s.isFile() && s.size < 2_000_000) lines = readFileSync(join(wt, p), 'utf8').split('\n').length; } catch { /* 무시 */ }
    rows.push({ path: p, change_type: 'added', lines_added: lines, lines_removed: 0 });
  }
  return rows;
}

export async function diffText(wt: string, baseSha: string, path?: string, maxBytes = 400_000): Promise<string> {
  const args = ['diff', '-M', baseSha];
  if (path) args.push('--', path);
  const r = await git(wt, args);
  let out = r.stdout;
  if (path) {
    const untracked = await git(wt, ['ls-files', '--others', '--exclude-standard', '--', path]);
    if (untracked.stdout.trim()) {
      const n = await git(wt, ['diff', '--no-index', '--', '/dev/null', path]);
      out += n.stdout;
    }
  }
  return out.length > maxBytes ? out.slice(0, maxBytes) + '\n… (잘림)' : out;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}
