import { st } from '../i18n.ts';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { Project } from '../../shared/types.ts';
import type { Store } from '../store.ts';
import { run } from '../util.ts';
import { saveBranchPatch, saveWorktreePatch } from './archive.ts';

/** 최근 이 시간 안에 손댄 worktree 는 다른 세션이 쓰는 중일 수 있어 남긴다 */
export const RECENT_H = 12;
const ACTIVE = ['running', 'reviving', 'queued', 'paused', 'waiting_human', 'idle', 'down'];
const ALWAYS_KEEP = ['main', 'master', 'dev', 'develop', 'prod', 'production', 'staging', 'release'];

export type Verdict = 'remove' | 'ask' | 'keep';
export interface WtItem { id: string; path: string; branch: string | null; kind: 'hivelane' | 'claude' | 'other'; verdict: Verdict; why: string; dirty: string[]; touchedH: number | null; team_id: string | null; missing: boolean; recent?: boolean }
export interface BrItem { id: string; name: string; verdict: Verdict; why: string; unpushed: number; lastCommit: string; inWorktree: string | null }
export interface Scan { project: Project; base: string; worktrees: WtItem[]; branches: BrItem[] }

/** --no-optional-locks: 살펴보기만으로 index 를 갱신해 「최근 사용」처럼 보이지 않게 */
const git = (cwd: string, args: string[], timeoutMs = 30_000) => run('git', ['--no-optional-locks', '-C', cwd, ...args], { timeoutMs });
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const under = (root: string, p: string) => [[resolve(root), resolve(p)], [real(root), real(p)]].some(([a, b]) => { const r = relative(a!, b!); return !r.startsWith('..') && !r.startsWith('/'); });
const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/** 모든 프로세스의 작업 폴더(그 안에서 무언가 돌고 있으면 쓰는 중) */
async function processCwds(): Promise<string[]> {
  const r = await run('lsof', ['-d', 'cwd', '-Fn'], { timeoutMs: 8000 });
  return r.stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
}

export async function scanGit(cfg: AppConfig, store: Store, project: Project): Promise<Scan> {
  const root = project.path;
  await git(root, ['worktree', 'prune', '--dry-run']);
  const base = project.base_ref || 'origin/main';
  const baseName = base.replace(/^origin\//, '');
  const keepNames = new Set([...ALWAYS_KEEP, baseName, ...project.protected_branches]);
  const teams = store.listTeams('1=1');
  const cwds = await processCwds();
  const now = Date.now();

  const wl = await git(root, ['worktree', 'list', '--porcelain']);
  const worktrees: WtItem[] = [];
  const blocks = wl.stdout.split('\n\n').filter((b) => b.startsWith('worktree '));
  for (const [i, block] of blocks.entries()) {
    const path = /^worktree (.+)$/m.exec(block)![1]!;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    if (i === 0) continue; // 본 저장소 폴더
    const missing = /^prunable/m.test(block) || !existsSync(path);
    const kind: WtItem['kind'] = under(cfg.worktreesDir, path) || under(cfg.standingDir, path) ? 'hivelane' : /\/\.claude\/worktrees\/|\/claude-\d+\/|scratchpad/.test(path) ? 'claude' : 'other';
    const t = teams.find((x) => x.worktree_path && (resolve(x.worktree_path) === resolve(path) || real(x.worktree_path) === real(path))) ?? null;
    const item: WtItem = { id: `wt:${path}`, path, branch, kind, verdict: 'remove', why: '', dirty: [], touchedH: null, team_id: t?.id ?? null, missing };
    if (missing) { item.why = st('폴더가 이미 없음(기록만 남음)'); worktrees.push(item); continue; }
    const gs = await git(path, ['status', '--porcelain']);
    item.dirty = gs.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.includes('node_modules'));
    const gd = (await git(path, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    // 끝난 Hivelane 팀 폴더는 Hivelane 자신의 조회가 index 를 건드렸을 수 있어 바뀐 파일 시각만 본다
    const finishedTeam = !!t && !ACTIVE.includes(t.state);
    const touched = Math.max(...(finishedTeam ? [Date.parse(t!.finished_at ?? t!.updated_at) || 0] : [mtime(join(gd, 'index')), mtime(join(gd, 'HEAD')), mtime(join(gd, 'logs', 'HEAD'))]), ...item.dirty.slice(0, 40).map((f) => mtime(join(path, f))));
    item.touchedH = touched ? Math.round((now - touched) / 36e5 * 10) / 10 : null;
    const ageNote = item.touchedH != null ? (item.touchedH < 48 ? st('마지막 손댐 {h}시간 전', { h: item.touchedH }) : st('마지막 손댐 {d}일 전', { d: Math.round(item.touchedH / 24) })) : '';
    if (/^locked/m.test(block)) { item.verdict = 'keep'; item.why = st('잠겨 있음(다른 세션이 잠금)'); }
    else if (t && t.lifetime === 'standing' && t.state !== 'archived') { item.verdict = 'keep'; item.why = st('직속 팀 「{name}」 작업 폴더', { name: t.name }); }
    else if (t && ACTIVE.includes(t.state)) { item.verdict = 'keep'; item.why = st('팀 「{name}」 {state}', { name: t.name, state: t.state }); }
    else if (cwds.some((c) => under(path, c))) { item.verdict = 'keep'; item.why = st('이 폴더 안에서 프로그램이 돌고 있음'); }
    else if (item.touchedH != null && item.touchedH < RECENT_H) { item.verdict = 'keep'; item.recent = true; item.why = st('최근 {h}시간 안에 사용({age})', { h: RECENT_H, age: ageNote }); }
    else if (item.dirty.length) { item.verdict = 'ask'; item.why = st('커밋 안 한 변경 {n}개 · {age}', { n: item.dirty.length, age: ageNote }); }
    else item.why = st('변경 없음 · {age}', { age: ageNote }) + (t ? ` · ${st('끝난 팀 「{name}」', { name: t.name })}` : '');
    worktrees.push(item);
  }

  const keptWtBranch = new Map(worktrees.filter((w) => w.verdict !== 'remove' && w.branch).map((w) => [w.branch!, w.path]));
  const wtBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]));
  const cur = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const merged = new Set((await git(root, ['branch', '--merged', base, '--format=%(refname:short)'])).stdout.split('\n').filter(Boolean));
  const bl = await git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)\t%(committerdate:relative)']);
  const branches: BrItem[] = [];
  for (const line of bl.stdout.split('\n').filter(Boolean)) {
    const [name, lastCommit = ''] = line.split('\t') as [string, string?];
    const b: BrItem = { id: `br:${name}`, name, verdict: 'remove', why: '', unpushed: 0, lastCommit, inWorktree: wtBranch.get(name) ?? null };
    if (name === cur) { b.verdict = 'keep'; b.why = st('본 폴더에서 쓰는 중'); }
    else if (keepNames.has(name)) { b.verdict = 'keep'; b.why = st('기준·보호 브랜치'); }
    else if (keptWtBranch.has(name)) { b.verdict = 'keep'; b.why = st('남기는 worktree 가 쓰는 중'); }
    else {
      const un = await git(root, ['rev-list', '--count', name, '--not', '--remotes', base]);
      b.unpushed = Number(un.stdout.trim()) || 0;
      if (merged.has(name)) b.why = st('{base} 에 이미 합쳐짐', { base });
      else if (!b.unpushed) b.why = st('모든 커밋이 원격에 있음(로컬 사본만 지움)');
      else { b.verdict = 'ask'; b.why = st('어디에도 없는 커밋 {n}개(원격·{base} 에 없음)', { n: b.unpushed, base }); }
      b.why += ` · ${st('마지막 커밋 {when}', { when: lastCommit })}`;
      if (b.inWorktree) b.why += ` · ${st('worktree 정리 후 지움')}`;
    }
    branches.push(b);
  }
  return { project, base, worktrees, branches };
}

export function formatScan(s: Scan): string {
  const tag = { remove: '[정리 가능]', ask: '[확인 필요]', keep: '[남김]' } as const;
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
  const w = s.worktrees.map((x) => `- ${tag[x.verdict]} ${x.id.replace(x.path, home(x.path))} (${x.kind === 'hivelane' ? 'Hivelane' : x.kind === 'claude' ? 'Claude 세션' : '기타'} · ${x.branch ?? 'detached'}) — ${x.why}${x.verdict === 'ask' ? `: ${x.dirty.slice(0, 8).join(', ')}${x.dirty.length > 8 ? ' …' : ''}` : ''}`);
  const b = s.branches.map((x) => `- ${tag[x.verdict]} ${x.id} — ${x.why}`);
  const n = (v: Verdict) => s.worktrees.filter((x) => x.verdict === v).length + s.branches.filter((x) => x.verdict === v).length;
  return `프로젝트 ${s.project.name} (기준 ${s.base}) · 정리 가능 ${n('remove')} · 확인 필요 ${n('ask')} · 남김 ${n('keep')}\n\nworktree ${s.worktrees.length}개\n${w.join('\n') || '- 없음'}\n\n로컬 브랜치 ${s.branches.length}개\n${b.join('\n')}\n\n(id 는 git_cleanup 에 그대로 넘긴다. 경로의 ~ 는 홈 폴더)`;
}

/** 다시 살펴본 뒤 지운다. keep 은 절대 안 지우고, ask 는 discard 일 때만. */
export async function applyCleanup(cfg: AppConfig, store: Store, project: Project, ids: string[], discard: boolean, archiveTeam: (teamId: string) => Promise<void>, by = '사용자'): Promise<string[]> {
  const s = await scanGit(cfg, store, project);
  const home = process.env.HOME ?? '';
  // wt: 경로는 ~ 를 풀고 실제 경로(/var → /private/var 등)로 맞춘다
  const want = new Set(ids.map((i) => { if (!i.startsWith('wt:')) return i; const p = i.slice(3).replace(/^~(?=\/|$)/, home); const hit = s.worktrees.find((w) => resolve(w.path) === resolve(p) || real(w.path) === real(p)); return hit ? hit.id : `wt:${p}`; }));
  const out: string[] = [];
  for (const w of s.worktrees.filter((x) => want.has(x.id))) {
    if (w.verdict === 'keep') { out.push(st('남김 {target}: {why}', { target: w.path, why: w.why })); continue; }
    if (w.verdict === 'ask' && !discard) { out.push(st('멈춤 {target}: {why} — 사용자 동의 후 discard_changes', { target: w.path, why: w.why })); continue; }
    if (w.team_id) await archiveTeam(w.team_id); // 팀 worktree 는 보관하면서 패치·기록을 남긴다
    let r: { code: number; stderr: string } = { code: 0, stderr: '' };
    if (w.missing) { r = await git(project.path, ['worktree', 'prune']); store.addCleanupLog({ project_id: project.id, team_id: w.team_id, kind: 'worktree', target: w.path, branch: w.branch, by, note: st('폴더가 이미 없음(기록만 정리)') }); }
    else if (existsSync(w.path)) {
      const patch = await saveWorktreePatch(cfg, w.path, null, `wt-${w.path.split('/').pop() ?? 'x'}`).catch(() => null);
      r = await git(project.path, ['worktree', 'remove', '--force', w.path], 120_000);
      if (r.code === 0) store.addCleanupLog({ project_id: project.id, team_id: w.team_id, kind: 'worktree', target: w.path, branch: w.branch, by, discarded: w.verdict === 'ask', patch_path: patch?.path ?? null, patch_files: patch?.files ?? 0, note: patch ? st('커밋 안 한 변경 {n}개 파일을 패치로 보관', { n: patch.files }) : w.why });
    }
    // 지운(또는 이미 없던) worktree 를 가리키던 팀 기록도 비운다 — 안 비우면 나중에 「팀 정리」가 없는 폴더를 지우려다 실패한다
    if (r.code === 0) clearTeamWorktree(store, w.path);
    out.push(r.code === 0 ? st('지움 worktree {target}', { target: w.path }) : st('실패 {target}: {err}', { target: w.path, err: r.stderr.trim() }));
  }
  await git(project.path, ['worktree', 'prune']);
  const s2 = want.size && [...want].some((i) => i.startsWith('br:')) ? await scanGit(cfg, store, project) : s;
  for (const b of s2.branches.filter((x) => want.has(x.id))) {
    if (b.verdict === 'keep') { out.push(st('남김 {target}: {why}', { target: b.name, why: b.why })); continue; }
    if (b.verdict === 'ask' && !discard) { out.push(st('멈춤 {target}: {why} — 사용자 동의 후 discard_changes', { target: b.name, why: b.why })); continue; }
    const saved = b.unpushed > 0 ? await saveBranchPatch(cfg, project.path, b.name, s2.base).catch(() => null) : null;
    const sha = saved?.sha || (await git(project.path, ['rev-parse', b.name])).stdout.trim();
    const r = await git(project.path, ['branch', '-D', b.name]);
    if (r.code === 0) store.addCleanupLog({ project_id: project.id, team_id: null, kind: 'branch', target: b.name, by, discarded: b.verdict === 'ask', patch_path: saved?.path || null, patch_files: saved?.files ?? 0, note: `${b.why} · ${st('되살리기: {cmd}', { cmd: `git branch ${b.name} ${sha.slice(0, 12)}` })}` });
    out.push(r.code === 0 ? st('지움 브랜치 {target}', { target: b.name }) : st('실패 {target}: {err}', { target: b.name, err: r.stderr.trim() }));
  }
  const unknown = [...want].filter((i) => !s.worktrees.some((w) => w.id === i) && !s2.branches.some((b) => b.id === i) && !s.branches.some((b) => b.id === i));
  if (unknown.length) out.push(st('못 찾음: {ids}', { ids: unknown.join(', ') }));
  return out;
}

/** applyCleanup 결과 중 지운 줄 수(「지움 …」 · 영어면 「Removed …」) */
export const countRemoved = (lines: string[]): number => lines.filter((l) => l.startsWith('지움') || l.startsWith(st('지움'))).length;

/** 이 경로를 worktree 로 기록한 팀(끝난 팀 포함)의 worktree_path 를 비운다 */
export function clearTeamWorktree(store: Store, path: string): number {
  const rows = store.db.prepare('SELECT id, worktree_path FROM teams WHERE worktree_path IS NOT NULL').all() as { id: string; worktree_path: string }[];
  const hit = rows.filter((r) => resolve(r.worktree_path) === resolve(path) || real(r.worktree_path) === real(path));
  for (const r of hit) store.updateTeam(r.id, { worktree_path: null });
  return hit.length;
}
