import { st } from '../i18n.ts';
import { bus } from '../bus.ts';
import { logger } from '../log.ts';
import type { Notifier } from '../notify/index.ts';
import type { Store } from '../store.ts';
import { run } from '../util.ts';
import type { PrView } from '../../shared/types.ts';

const log = logger('prs');
const FIELDS = 'number,title,url,state,isDraft,headRefName,baseRefName,author,createdAt,updatedAt,mergedAt,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus';
/** 닫히거나 병합된 PR 을 이 시간까지는 목록에 남긴다 */
const KEEP_CLOSED_MS = 3 * 86_400_000;

interface GhPr {
  number: number; title: string; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; headRefName: string; baseRefName: string;
  author: { login: string } | null; createdAt: string; updatedAt: string; mergedAt: string | null; reviewDecision: string | null;
  statusCheckRollup: { conclusion?: string | null; state?: string | null; status?: string | null; name?: string; context?: string; workflowName?: string; detailsUrl?: string; targetUrl?: string }[] | null;
  mergeable?: string; mergeStateStatus?: string;
}

export function checkListOf(r: GhPr['statusCheckRollup']): PrView['check_list'] {
  return (r ?? []).map((c) => {
    const v = (c.conclusion ?? c.state ?? c.status ?? '').toUpperCase();
    const state: PrView['check_list'][number]['state'] = ['SUCCESS', 'NEUTRAL'].includes(v) ? 'pass' : ['SKIPPED'].includes(v) ? 'skip'
      : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v) ? 'fail' : 'pending';
    const name = c.name ? (c.workflowName && c.workflowName !== c.name ? `${c.workflowName} / ${c.name}` : c.name) : c.context ?? st('검사');
    return { name, state, url: c.detailsUrl ?? c.targetUrl ?? null };
  });
}

export function checksOf(r: GhPr['statusCheckRollup']): PrView['checks'] {
  if (!r?.length) return 'none';
  const v = r.map((c) => (c.conclusion ?? c.state ?? c.status ?? '').toUpperCase());
  if (v.some((x) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(x))) return 'fail';
  if (v.some((x) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', ''].includes(x))) return 'pending';
  return 'pass';
}

/** 등록된 저장소의 PR 을 gh 로 주기적으로 읽어 화면에 준다. Hivelane 팀이 만든 PR 은 팀과 잇고 새로 생기면 알린다. */
export class PrWatcher {
  private list: PrView[] = [];
  private errors: Record<string, string> = {};
  private known = new Set<string>();
  private first = true;
  private busy = false;
  lastAt: string | null = null;

  constructor(private deps: { store: Store; notifier: Notifier; gh?: string }) {}

  get prs(): PrView[] { return this.list; }
  get problems(): Record<string, string> { return this.errors; }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const out: PrView[] = [];
      const errors: Record<string, string> = {};
      const now = Date.now();
      for (const p of this.deps.store.listProjects()) {
        const r = await run(this.deps.gh ?? 'gh', ['pr', 'list', '--state', 'all', '--limit', '30', '--json', FIELDS], { cwd: p.path, timeoutMs: 25_000 });
        if (r.code !== 0) { if (!/no git remotes/i.test(r.stderr)) errors[p.name] = r.stderr.trim().slice(0, 200) || st('gh 종료 코드 {code}', { code: String(r.code) }); continue; }
        let rows: GhPr[] = [];
        try { rows = JSON.parse(r.stdout) as GhPr[]; } catch { errors[p.name] = st('gh 출력 해석 실패'); continue; }
        for (const g of rows) {
          if (g.state !== 'OPEN' && now - Date.parse(g.mergedAt ?? g.updatedAt) > KEEP_CLOSED_MS) continue;
          out.push({
            project_id: p.id, project_name: p.name, number: g.number, title: g.title, url: g.url, state: g.state, draft: g.isDraft,
            head: g.headRefName, base: g.baseRefName, author: g.author?.login ?? '', created_at: g.createdAt, updated_at: g.updatedAt, merged_at: g.mergedAt,
            review: g.reviewDecision ?? null, checks: checksOf(g.statusCheckRollup), check_list: checkListOf(g.statusCheckRollup), mergeable: g.mergeable ?? 'UNKNOWN', merge_state: g.mergeStateStatus ?? 'UNKNOWN', team_id: this.teamOf(g),
          });
        }
      }
      out.sort((a, b) => (a.state === 'OPEN' ? 0 : 1) - (b.state === 'OPEN' ? 0 : 1) || b.updated_at.localeCompare(a.updated_at));
      // 새로 생긴, 팀이 만든 PR 은 알린다(처음 읽을 때는 기준만 잡는다)
      for (const pr of out) {
        const key = `${pr.url}#${pr.state}`;
        if (!this.known.has(key) && !this.first && pr.team_id) {
          const t = this.deps.store.getTeam(pr.team_id);
          const what = pr.state === 'OPEN' ? st('새 PR') : pr.state === 'MERGED' ? st('PR 병합됨') : st('PR 닫힘');
          void this.deps.notifier.send({ title: `${what} · ${pr.project_name} #${pr.number}`, body: `${pr.title}\n${pr.base} ← ${pr.head}${t ? ` · ${t.name}` : ''}`, level: pr.state === 'OPEN' ? 'info' : 'good', url: pr.url, tag: `pr-${pr.url}` });
        }
        this.known.add(key);
      }
      this.first = false;
      const changed = JSON.stringify(out) !== JSON.stringify(this.list) || JSON.stringify(errors) !== JSON.stringify(this.errors);
      this.list = out; this.errors = errors; this.lastAt = new Date().toISOString();
      if (changed) bus.changed('prs');
    } catch (e) { log.warn('PR 목록 갱신 실패', e); } finally { this.busy = false; }
  }

  /** 화면에서 병합: gh pr merge. 보호 규칙·충돌은 gh 가 거절하고 그 이유를 돌려준다. */
  async merge(projectId: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<{ ok: boolean; message: string }> {
    const p = this.deps.store.getProject(projectId);
    if (!p) return { ok: false, message: st('프로젝트가 없습니다') };
    const r = await run(this.deps.gh ?? 'gh', ['pr', 'merge', String(number), `--${method}`], { cwd: p.path, timeoutMs: 60_000 });
    const message = (r.stdout + '\n' + r.stderr).trim().slice(0, 600);
    log.info(`PR 병합 ${p.name} #${number} (${method}) → ${r.code === 0 ? '성공' : '실패'} ${message}`);
    void this.refresh();
    return { ok: r.code === 0, message: message || (r.code === 0 ? st('병합했습니다') : st('gh 종료 코드 {code}', { code: String(r.code) })) };
  }

  /** PR 을 만든 Hivelane 팀: 팀 브랜치가 head 이거나, 팀 기록에 PR 주소가 남아 있으면 */
  private teamOf(g: GhPr): string | null {
    const db = this.deps.store.db;
    const byBranch = db.prepare('SELECT id FROM teams WHERE branch = ? ORDER BY created_at DESC LIMIT 1').get(g.headRefName) as { id: string } | undefined;
    if (byBranch) return byBranch.id;
    const byMsg = db.prepare("SELECT team_id FROM agent_events WHERE team_id IS NOT NULL AND body LIKE ? ORDER BY id DESC LIMIT 1").get(`%${g.url}%`) as { team_id: string } | undefined;
    if (byMsg) return byMsg.team_id;
    const byChat = db.prepare("SELECT team_id FROM messages WHERE team_id IS NOT NULL AND body LIKE ? ORDER BY id DESC LIMIT 1").get(`%${g.url}%`) as { team_id: string } | undefined;
    return byChat?.team_id ?? null;
  }
}
