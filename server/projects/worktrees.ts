import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { Store } from '../store.ts';
import { run } from '../util.ts';
import { removeWorktree } from './git.ts';

const ACTIVE = ['running', 'reviving', 'queued', 'paused', 'waiting_human', 'idle', 'down'];

export interface WtInfo {
  project_id: string; project: string; path: string; branch: string | null;
  team_id: string | null; team_name: string | null; team_state: string | null; lifetime: string | null;
  /** 커밋 안 한 변경 파일 */
  dirty: string[];
  /** 기준보다 앞선 커밋 수(브랜치에만 있는 커밋) */
  ahead: number;
  /** 폴더가 사라진 기록만 남은 것 */
  missing: boolean;
  /** 지금 팀이 쓰지 않는 것(정리 후보) */
  orphan: boolean;
}

const git = (cwd: string, args: string[]) => run('git', ['-C', cwd, ...args], { timeoutMs: 30_000 });
/** macOS 의 /var → /private/var 같은 링크를 풀어서 비교 */
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (root: string, p: string) => { const a = real(root); const b = real(p); for (const [x, y] of [[a, b], [resolve(root), resolve(p)]] as const) { const r = relative(x, y); if (r && !r.startsWith('..')) return true; } return false; };
const same = (a: string, b: string) => resolve(a) === resolve(b) || real(a) === real(b);

/** Hivelane 이 만든 worktree(설정 폴더 아래)만 본다. 사용자가 직접 만든 worktree 는 건드리지 않는다. */
export async function listWorktrees(cfg: AppConfig, store: Store): Promise<WtInfo[]> {
  const teams = store.listTeams('1=1');
  const out: WtInfo[] = [];
  for (const p of store.listProjects()) {
    const r = await git(p.path, ['worktree', 'list', '--porcelain']);
    if (r.code !== 0) continue;
    for (const block of r.stdout.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (!path || !(inside(cfg.worktreesDir, path) || inside(cfg.standingDir, path))) continue;
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
      const missing = /^prunable/m.test(block) || !existsSync(path);
      const t = teams.find((x) => x.worktree_path && same(x.worktree_path, path)) ?? null;
      let dirty: string[] = []; let ahead = 0;
      if (!missing) {
        const st = await git(path, ['status', '--porcelain']);
        dirty = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.includes('node_modules'));
        const base = t?.base_sha ?? p.base_ref;
        const a = await git(path, ['rev-list', '--count', `${base}..HEAD`]);
        ahead = Number(a.stdout.trim()) || 0;
      }
      out.push({ project_id: p.id, project: p.name, path, branch, team_id: t?.id ?? null, team_name: t?.name ?? null, team_state: t?.state ?? null, lifetime: t?.lifetime ?? null, dirty, ahead, missing, orphan: !t || !ACTIVE.includes(t.state) });
    }
  }
  return out;
}

/** 정리: worktree 를 지우고(선택) Hivelane 브랜치도 지운다. 확인은 부르는 쪽에서. */
export async function removeHivelaneWorktree(cfg: AppConfig, projectPath: string, wt: WtInfo, deleteBranch: boolean): Promise<string> {
  if (!(inside(cfg.worktreesDir, wt.path) || inside(cfg.standingDir, wt.path))) throw new Error('Hivelane 이 만든 worktree 가 아니다');
  await removeWorktree(projectPath, wt.path);
  await git(projectPath, ['worktree', 'prune']);
  let note = 'worktree 를 지웠다';
  if (deleteBranch && wt.branch) {
    if (!wt.branch.startsWith('hivelane/')) return `${note} · 브랜치 ${wt.branch} 는 Hivelane 브랜치가 아니라 남김`;
    const r = await git(projectPath, ['branch', '-D', wt.branch]);
    note += r.code === 0 ? ` · 브랜치 ${wt.branch} 삭제` : ` · 브랜치 삭제 실패: ${r.stderr.trim()}`;
  }
  return note;
}
