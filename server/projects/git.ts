import { st } from '../i18n.ts';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  if (r.code !== 0) throw new Error(st('{cmd} 실패: {err}', { cmd: `git ${args.join(' ')}`, err: r.stderr.trim() || r.stdout.trim() }));
  return r.stdout.trim();
}

export interface RepoInfo { root: string; name: string; baseRef: string; memoryPaths: string[]; hasNode: boolean; remote: RemoteInfo | null }
export interface RemoteInfo { name: string; url: string; web: string | null; label: string }

/** git 원격 주소 → 웹 주소·짧은 이름(github.com/owner/repo). 비밀번호·토큰이 박힌 주소는 가린다 */
export function describeRemote(name: string, raw: string): RemoteInfo {
  const url = raw.trim().replace(/\/\/[^/@\s]+@/, '//');
  let host = '', path = '';
  const ssh = url.match(/^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)[:/](.+?)(?:\.git)?\/?$/);
  const http = url.match(/^https?:\/\/([\w.-]+(?::\d+)?)\/(.+?)(?:\.git)?\/?$/);
  if (http) { host = http[1]!; path = http[2]!; } else if (ssh) { host = ssh[1]!; path = ssh[2]!; }
  const label = host ? `${host}/${path}` : url;
  return { name, url, web: host ? `https://${host}/${path}` : null, label };
}

/** origin(없으면 첫 번째 원격)의 주소 */
export async function remoteOf(root: string): Promise<RemoteInfo | null> {
  const names = (await git(root, ['remote'])).stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!names.length) return null;
  const name = names.includes('origin') ? 'origin' : names[0]!;
  const u = await git(root, ['remote', 'get-url', name]);
  return u.code === 0 && u.stdout.trim() ? describeRemote(name, u.stdout) : null;
}

/** 경로가 git 저장소인지 확인하고 기본값을 추정한다. */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  const abs = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(st('폴더가 없습니다: {path}', { path: abs }));
  const root = await gitOk(abs, ['rev-parse', '--show-toplevel']).catch(() => { throw new Error(st('git 저장소가 아닙니다: {path}', { path: abs })); });
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
  // Node 프로젝트인지(어디든 package.json 이 있는지) — 패키지 준비 방식 기본값을 고르는 데 쓴다
  const pkgs = await git(root, ['ls-files', '--', 'package.json', '**/package.json']);
  const hasNode = !!pkgs.stdout.trim() || existsSync(join(root, 'package.json'));
  return { root, name: basename(root), baseRef, memoryPaths: existsSync(memDir) ? [memDir] : [], hasNode, remote: await remoteOf(root) };
}

const DEFAULT_IGNORE = ['node_modules/', '.env', '.env.*', '!.env.example', '*.log', '.DS_Store', 'dist/', 'build/', '.next/', 'coverage/', '.venv/', '__pycache__/', '*.pyc', '.idea/', '.vscode/'];

/**
 * git 이 아닌 폴더를 저장소로 시작한다: (없으면) 기본 .gitignore → git init → 첫 커밋.
 * 홈·루트처럼 넓은 곳, 다른 저장소 안쪽, 이미 저장소인 곳은 거절한다.
 */
export async function initRepo(path: string): Promise<RepoInfo> {
  const abs = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(st('폴더가 없습니다: {path}', { path: abs }));
  const home = homedir();
  const parts = abs.split('/').filter(Boolean);
  if (abs === '/' || abs === home || parts.length < 3 || ['/Applications', '/System', '/Library', '/usr', '/opt', '/private', '/Volumes'].some((p) => abs === p || abs.startsWith(`${p}/`)) || [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads'), join(home, 'Library')].includes(abs)) {
    throw new Error(st('이 위치에서는 git 을 시작하지 않습니다(너무 넓거나 시스템 폴더): {path}', { path: abs }));
  }
  const inside = await git(abs, ['rev-parse', '--show-toplevel']);
  if (inside.code === 0) throw new Error(st('이미 git 저장소(또는 그 안쪽)입니다: {path}', { path: inside.stdout.trim() }));
  const ignore = join(abs, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, `# Hivelane 이 git 을 시작하며 만든 기본 목록\n${DEFAULT_IGNORE.join('\n')}\n`);
  await gitOk(abs, ['init', '-b', 'main']);
  await gitOk(abs, ['add', '-A'], 300_000);
  // 이름·메일이 설정돼 있지 않아도 첫 커밋은 되게(설정돼 있으면 그것을 씀)
  const who = (await git(abs, ['config', 'user.email'])).stdout.trim() ? [] : ['-c', 'user.name=Hivelane', '-c', 'user.email=hivelane@localhost'];
  await gitOk(abs, [...who, 'commit', '--allow-empty', '-q', '-m', 'Hivelane: 처음 상태'], 300_000);
  log.info(`git 시작 ${abs}`);
  return inspectRepo(abs);
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
  if (existsSync(dir)) throw new Error(st('worktree 경로가 이미 있습니다: {path}', { path: dir }));
  if (exists.code === 0) await gitOk(root, ['worktree', 'add', dir, branch]);
  else await gitOk(root, ['worktree', 'add', '-b', branch, dir, baseSha]);
  return { path: dir, branch, baseSha };
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  if (!existsSync(dir)) { await pruneWorktrees(root); return; }
  await gitOk(root, ['worktree', 'remove', '--force', dir]);
}

/** git 에 남은 「없는 worktree」 기록 지우기 */
export async function pruneWorktrees(root: string): Promise<void> { await git(root, ['worktree', 'prune']); }

/** worktree 를 지우려 했는데 이미 지워졌거나 git 이 worktree 로 모를 때의 오류인지 */
export function isGoneWorktreeError(e: unknown): boolean {
  return /is not a working tree|not a git repository|No such file or directory/i.test(e instanceof Error ? e.message : String(e));
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
  const v = s.toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return v && !/^\.+$/.test(v) ? v : 'project';
}
