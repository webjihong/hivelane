import type { AppConfig } from '../config.ts';
import type { CleanItem, CleanScanView, GitCleanSummary } from '../../shared/types.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';
import type { Orchestrator } from '../teams/orchestrator.ts';
import { applyCleanup, scanGit, type Scan } from './gitclean.ts';

const log = logger('gitclean');

/** 정리하면서 그 worktree 를 쓰던 끝난 업무 팀은 보관으로(돌고 있는 팀·직속 팀은 건드리지 않음) */
export function archiveForCleanup(store: Store, orch: Orchestrator, by = '사용자') {
  return async (teamId: string): Promise<void> => {
    const t = store.getTeam(teamId);
    if (!t || t.lifetime !== 'task' || orch.isRunning(teamId)) return;
    if (!['done', 'failed', 'archived'].includes(t.state)) await orch.cancel(teamId);
    if (t.state !== 'archived') await orch.archive(teamId, by).catch(() => {});
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
      await this.autoClean().catch((e) => log.warn('자동 정리 실패', e instanceof Error ? e.message : e));
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

  /** 끝난 지 autoCleanDays 일이 지난 업무 팀의 worktree 를 패치로 남기고 정리(잠김·안에서 도는 프로그램은 건너뜀). 브랜치는 남긴다 */
  async autoClean(now = Date.now()): Promise<string[]> {
    const { store } = this.deps;
    const days = store.getSettings().autoCleanDays;
    if (!days || days <= 0) return [];
    const cutoff = now - days * 86_400_000;
    const due = store.listTeams("lifetime = 'task' AND state IN ('done','failed') AND worktree_path IS NOT NULL").filter((t) => Date.parse(t.finished_at ?? t.updated_at) < cutoff);
    const done: string[] = [];
    for (const t of due) {
      const r = await this.cleanTeam(t.id, true, '자동').catch((e) => ({ result: 'blocked' as const, message: e instanceof Error ? e.message : String(e) }));
      if (r.result === 'done') done.push(t.name);
    }
    if (done.length) store.addChat({ role: 'event', body: `자동 정리 · 끝난 지 ${days}일 지난 팀 worktree ${done.length}개 (${done.slice(0, 8).join(', ')}${done.length > 8 ? ' …' : ''}) · 변경은 패치로 보관, 브랜치는 남김`, tone: 'info' });
    return done;
  }

  /**
   * 끝난 팀 하나의 worktree 정리(팀 채널·팀 상세 버튼). 브랜치는 남긴다.
   * 사용자가 그 팀을 콕 집었으므로 「최근 사용」은 막지 않지만, 잠김·안에서 도는 프로그램은 막고, 커밋 안 한 변경은 discard 동의가 있어야 지운다.
   */
  async cleanTeam(teamId: string, discard: boolean, by = '팀 버튼'): Promise<{ result: 'done' | 'dirty' | 'blocked'; message: string; dirty?: string[] }> {
    const { cfg, store, orch } = this.deps;
    const t = store.getTeam(teamId);
    if (!t) return { result: 'blocked', message: '팀이 없습니다' };
    if (t.lifetime !== 'task' || orch.isRunning(teamId) || !['done', 'failed'].includes(t.state)) return { result: 'blocked', message: '끝난 업무 팀만 정리할 수 있습니다' };
    const p = store.getProject(t.project_id);
    const item = p && t.worktree_path ? (await scanGit(cfg, store, p)).worktrees.find((w) => w.team_id === teamId) : undefined;
    if (item && item.verdict === 'keep' && !item.why.startsWith('최근')) return { result: 'blocked', message: `지우지 않음: ${item.why}` };
    if (item && item.dirty.length && !discard) return { result: 'dirty', message: `커밋 안 한 변경 ${item.dirty.length}개가 있습니다`, dirty: item.dirty.slice(0, 20) };
    await orch.archive(teamId, by, { discarded: !!item?.dirty.length });
    const msg = `worktree 정리(${by}) · 「${t.name}」 · 브랜치 ${t.branch ?? '-'} 는 남김${item?.dirty.length ? ` · 커밋 안 한 변경 ${item.dirty.length}개는 패치로 보관` : ''}`;
    if (by !== '자동') store.addChat({ role: 'event', body: msg, team_id: teamId, tone: 'info' });
    if (p) { try { this.scans.set(p.id, toView(await scanGit(cfg, store, p))); } catch { /* 다음 주기에 */ } }
    this.deps.onChange();
    return { result: 'done', message: msg };
  }

  /** 화면에서 고른 것만 지운다. keep 은 안 지우고, ask 는 discard 일 때만(gitclean 이 다시 살펴보고 판단) */
  async apply(projectId: string, ids: string[], discard: boolean): Promise<string[]> {
    const { cfg, store, orch } = this.deps;
    const p = store.getProject(projectId);
    if (!p) throw new Error('프로젝트가 없습니다');
    const lines = await applyCleanup(cfg, store, p, ids, discard, archiveForCleanup(store, orch, '화면'), '화면');
    const done = lines.filter((l) => l.startsWith('지움')).length;
    store.addChat({ role: 'event', body: `git 정리(화면) · ${p.name} · ${done}개 지움${discard ? ' (변경 버림 동의)' : ''}\n${lines.join('\n')}`, tone: 'info' });
    try { this.scans.set(p.id, toView(await scanGit(cfg, store, p))); } catch { /* 다음 주기에 */ }
    this.deps.onChange();
    return lines;
  }
}
