import { bus } from '../bus.ts';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';
import { run } from '../util.ts';
import type { RepoView } from '../../shared/types.ts';

const log = logger('repos');

/** 등록된 저장소(메인 폴더)의 브랜치·원격 대비 앞뒤·로컬 변경을 주기적으로 읽고, 화면에서 pull(빨리 감기만) 한다. */
export class RepoWatcher {
  private list: RepoView[] = [];
  private busy = false;
  private pulling = new Set<string>();

  constructor(private deps: { store: Store; git?: string }) {}
  get repos(): RepoView[] { return this.list.map((r) => ({ ...r, pulling: this.pulling.has(r.project_id) })); }

  private git(cwd: string, args: string[], timeoutMs = 30_000) { return run(this.deps.git ?? 'git', args, { cwd, timeoutMs }); }

  async status(projectId: string, fetch: boolean): Promise<RepoView | null> {
    const p = this.deps.store.getProject(projectId);
    if (!p) return null;
    const v: RepoView = { project_id: p.id, project_name: p.name, path: p.path, branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, fetched_at: null, error: null, pulling: false };
    if (fetch) {
      const f = await this.git(p.path, ['fetch', '--quiet', '--prune']);
      if (f.code === 0) v.fetched_at = new Date().toISOString();
      else v.error = `fetch 실패: ${f.stderr.trim().slice(0, 160)}`;
    } else v.fetched_at = this.list.find((x) => x.project_id === p.id)?.fetched_at ?? null;
    const b = await this.git(p.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    v.branch = b.code === 0 ? b.stdout.trim() : null;
    const u = await this.git(p.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (u.code === 0) {
      v.upstream = u.stdout.trim();
      const c = await this.git(p.path, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
      const [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
      v.ahead = ahead ?? 0; v.behind = behind ?? 0;
    }
    const s = await this.git(p.path, ['status', '--porcelain']);
    v.dirty = s.stdout.split('\n').filter(Boolean).length;
    return v;
  }

  async refresh(fetch = true): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const out: RepoView[] = [];
      for (const p of this.deps.store.listProjects()) { const v = await this.status(p.id, fetch); if (v) out.push(v); }
      const changed = JSON.stringify(out) !== JSON.stringify(this.list);
      this.list = out;
      if (changed) bus.changed('repos');
    } catch (e) { log.warn('저장소 상태 갱신 실패', e); } finally { this.busy = false; }
  }

  /** git pull --ff-only: 로컬 커밋과 갈라졌거나 로컬 변경과 겹치면 git 이 거절하고 그 이유를 돌려준다. */
  async pull(projectId: string): Promise<{ ok: boolean; message: string }> {
    const p = this.deps.store.getProject(projectId);
    if (!p) return { ok: false, message: '프로젝트가 없습니다' };
    if (this.pulling.has(projectId)) return { ok: false, message: '이미 받는 중입니다' };
    this.pulling.add(projectId); bus.changed('repos');
    try {
      const before = (await this.git(p.path, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
      const r = await this.git(p.path, ['pull', '--ff-only'], 120_000);
      const after = (await this.git(p.path, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
      const text = (r.stdout + '\n' + r.stderr).trim();
      log.info(`pull ${p.name} ${before}→${after} 코드 ${r.code}`);
      const v = await this.status(projectId, false);
      if (v) { this.list = this.list.map((x) => (x.project_id === projectId ? { ...v, fetched_at: new Date().toISOString() } : x)); }
      if (r.code !== 0) {
        const why = /diverged|Not possible to fast-forward/i.test(text) ? '로컬 커밋과 원격이 갈라져 빨리 감기로 받을 수 없습니다(직접 병합·리베이스 필요)'
          : /would be overwritten|Please commit your changes or stash/i.test(text) ? '받을 내용이 로컬에서 고친 파일과 겹칩니다(커밋하거나 치운 뒤 다시)'
          : /no tracking information/i.test(text) ? '이 브랜치는 원격 브랜치가 연결되어 있지 않습니다' : text.slice(0, 300);
        return { ok: false, message: why };
      }
      return { ok: true, message: before === after ? '이미 최신입니다' : `${before} → ${after} 받았습니다` };
    } finally { this.pulling.delete(projectId); bus.changed('repos'); }
  }
}
