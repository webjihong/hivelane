import type { AppConfig } from '../config.ts';
import type { CleanItem, CleanScanView, GitCleanSummary } from '../../shared/types.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';
import type { Orchestrator } from '../teams/orchestrator.ts';
import { applyCleanup, scanGit, type Scan } from './gitclean.ts';

const log = logger('gitclean');

/** 정리하면서 그 worktree 를 쓰던 끝난 업무 팀은 보관으로(돌고 있는 팀·직속 팀은 건드리지 않음) */
export function archiveForCleanup(store: Store, orch: Orchestrator) {
  return async (teamId: string): Promise<void> => {
    const t = store.getTeam(teamId);
    if (!t || t.lifetime !== 'task' || orch.isRunning(teamId)) return;
    if (!['done', 'failed', 'archived'].includes(t.state)) await orch.cancel(teamId);
    if (t.state !== 'archived') await orch.archive(teamId).catch(() => {});
  };
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

export function toView(s: Scan): CleanScanView {
  const items: CleanItem[] = [
    ...s.worktrees.map((w): CleanItem => ({ id: w.id, kind: 'worktree', label: home(w.path), sub: w.branch ?? 'detached', verdict: w.verdict, why: w.why, dirty: w.dirty.slice(0, 20) })),
    ...s.branches.map((b): CleanItem => ({ id: b.id, kind: 'branch', label: b.name, sub: b.inWorktree ? home(b.inWorktree) : null, verdict: b.verdict, why: b.why })),
  ];
  return { project_id: s.project.id, project_name: s.project.name, base: s.base, items };
}

/** 등록된 저장소마다 정리할 worktree·로컬 브랜치를 주기적으로 세어 둔다(사이드바 버튼용) */
export class GitCleanWatcher {
  private scans = new Map<string, CleanScanView>();
  private takenAt: string | null = null;
  private running: Promise<void> | null = null;

  constructor(private deps: { cfg: AppConfig; store: Store; orch: Orchestrator; onChange: () => void }) {}

  get summary(): GitCleanSummary {
    const all = [...this.scans.values()].flatMap((s) => s.items);
    return { remove: all.filter((i) => i.verdict === 'remove').length, ask: all.filter((i) => i.verdict === 'ask').length, takenAt: this.takenAt, running: !!this.running };
  }

  get views(): CleanScanView[] { return [...this.scans.values()].sort((a, b) => a.project_name.localeCompare(b.project_name)); }

  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const projects = this.deps.store.listProjects();
      const next = new Map<string, CleanScanView>();
      for (const p of projects) {
        try { next.set(p.id, toView(await scanGit(this.deps.cfg, this.deps.store, p))); } catch (e) { log.warn(`살펴보기 실패 ${p.name}`, e instanceof Error ? e.message : e); const old = this.scans.get(p.id); if (old) next.set(p.id, old); }
      }
      this.scans = next;
      this.takenAt = new Date().toISOString();
    })().finally(() => { this.running = null; this.deps.onChange(); });
    this.deps.onChange();
    return this.running;
  }

  /** 화면에서 고른 것만 지운다. keep 은 안 지우고, ask 는 discard 일 때만(gitclean 이 다시 살펴보고 판단) */
  async apply(projectId: string, ids: string[], discard: boolean): Promise<string[]> {
    const { cfg, store, orch } = this.deps;
    const p = store.getProject(projectId);
    if (!p) throw new Error('프로젝트가 없습니다');
    const lines = await applyCleanup(cfg, store, p, ids, discard, archiveForCleanup(store, orch));
    const done = lines.filter((l) => l.startsWith('지움')).length;
    store.addChat({ role: 'event', body: `git 정리(화면) · ${p.name} · ${done}개 지움${discard ? ' (변경 버림 동의)' : ''}\n${lines.join('\n')}`, tone: 'info' });
    try { this.scans.set(p.id, toView(await scanGit(cfg, store, p))); } catch { /* 다음 주기에 */ }
    this.deps.onChange();
    return lines;
  }
}
