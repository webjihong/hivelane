import type { DB } from './db/index.ts';
import { bus, type AgentEventRow, type ChatRow } from './bus.ts';
import { newId, nowIso, parseJson } from './util.ts';
import {
  DEFAULT_SETTINGS,
  type AgentDetail, type AgentState, type KnowledgeView, type AgentView, type ChatView, type Model, type Priority, type Project,
  type ProposalView, type RunMode, type Settings, type TeamDetail, type TeamState, type TeamTemplate, type TeamView, type TemplateRole,
} from '../shared/types.ts';

/* ---------- 행 타입 ---------- */
export interface TeamRow {
  id: string; task_id: string | null; project_id: string | null; name: string; managed_by: 'po' | 'user'; lifetime: 'task' | 'standing';
  standing_brief: string; check_command: string | null; check_interval_sec: number | null; last_check_at: string | null; last_check_ok: number | null;
  readable_team_ids: string; worktree_path: string | null; branch: string | null; base_sha: string | null; state: TeamState; stage: number;
  paused_reason: string | null; pause_kind: string | null; pinned: number; priority: Priority; question: string | null; nudges: number;
  cost_usd: number; budget_usd: number | null; error: string | null; last_activity_at: string | null; last_heartbeat_at: string | null;
  revived_count: number; created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
}
export interface AgentRow {
  id: string; team_id: string | null; role_key: string; role_name: string; model: Model; run_mode: RunMode; parent_agent_id: string | null;
  session_id: string | null; state: AgentState; current_step: string; system_prompt: string; allowed_tools: string; cost_usd: number;
  tokens_in: number; tokens_out: number; context_tokens: number; created_at: string; updated_at: string;
}
export interface TaskRow {
  id: string; project_id: string | null; title: string; instruction: string; brief: string; priority: Priority; status: string;
  template_id: string | null; budget_usd: number | null; created_at: string; updated_at: string; finished_at: string | null;
}
interface ProjectRow { id: string; name: string; path: string; base_ref: string; deps_strategy: string; heavy_patterns: string; blocked_patterns: string; memory_paths: string; default_template_id: string | null }
interface ProposalRow { id: string; project_id: string | null; title: string; instruction: string; brief: string; template_id: string | null; roles: string; priority: Priority; budget_usd: number | null; note: string; status: 'pending' | 'approved' | 'rejected'; task_id: string | null; created_at: string; decided_at: string | null }

export const DEFAULT_HEAVY = [
  '\\bjest\\b', '\\bvitest\\b', '\\btsc\\b', 'next build', 'nest build', 'docusaurus build', 'node --test', 'playwright test',
  '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?(build|test|typecheck|lint|e2e)\\b', '\\bnpm\\s+t\\b', '\\bnpx\\s+(jest|vitest|tsc|playwright)\\b',
];
export const DEFAULT_BLOCKED = [
  // git 전역 옵션(-C dir, -c k=v, --git-dir=…, --no-pager)을 건너뛴 뒤의 하위 명령까지 본다
  '\\bgit\\b(\\s+(-C|-c)\\s+\\S+|\\s+--?[\\w-]+(=\\S+)?)*\\s+(commit|push|rebase|merge|cherry-pick|tag|stash|switch|update-ref|am|revert|pull|fetch|gc|prune|filter-branch|replace|notes)\\b',
  '\\bgit\\b(\\s+(-C|-c)\\s+\\S+|\\s+--?[\\w-]+(=\\S+)?)*\\s+reset\\s+(--hard|--keep|--merge)',
  '\\bgit\\b(\\s+(-C|-c)\\s+\\S+|\\s+--?[\\w-]+(=\\S+)?)*\\s+(checkout|restore)\\s+(-f|--force|-b|-B|--orphan|--source)',
  '\\bgit\\b(\\s+(-C|-c)\\s+\\S+|\\s+--?[\\w-]+(=\\S+)?)*\\s+branch\\s+(-f|-d|-D|-m|-M|--force|--delete|--move)',
  '\\bgit\\b(\\s+(-C|-c)\\s+\\S+|\\s+--?[\\w-]+(=\\S+)?)*\\s+clean\\b',
  '\\bgit\\b(\\s+(-C|-c)\\s+\\S+|\\s+--?[\\w-]+(=\\S+)?)*\\s+worktree\\s+(add|remove|prune|move)\\b',
  '\\bgh\\s+(pr|release|repo)\\s+(create|merge|delete|edit)',
  'db:prod', 'prod:sync', '--profile\\s+\\S*prod', '\\bterraform\\s+(apply|destroy)',
  '\\brm\\s+-rf?\\s+(/|~|\\$HOME)(\\s|$)', '\\bsudo\\b', 'npm\\s+publish',
];

export class Store {
  constructor(readonly db: DB) {}

  /* ---------- settings ---------- */
  getSettings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
    const saved = parseJson<Partial<Settings>>(row?.value, {});
    return { ...DEFAULT_SETTINGS, ...saved, engine: { ...DEFAULT_SETTINGS.engine, ...(saved.engine ?? {}) }, embedding: { ...DEFAULT_SETTINGS.embedding, ...(saved.embedding ?? {}) } };
  }
  saveSettings(patch: Partial<Settings>): Settings {
    const cur = this.getSettings();
    const next: Settings = { ...cur, ...patch, engine: { ...cur.engine, ...(patch.engine ?? {}) }, embedding: { ...cur.embedding, ...(patch.embedding ?? {}) } };
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    bus.changed('settings');
    return next;
  }
  getKv<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return parseJson(row?.value, fallback);
  }
  setKv(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /* ---------- projects ---------- */
  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as ProjectRow[]).map(toProject);
  }
  getProject(id: string | null | undefined): Project | null {
    if (!id) return null;
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }
  findProjectByName(name: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?) OR id = ?').get(name, name) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }
  insertProject(p: Omit<Project, 'id'>): Project {
    const id = newId('p');
    const ts = nowIso();
    this.db.prepare(`INSERT INTO projects (id, name, path, base_ref, deps_strategy, heavy_patterns, blocked_patterns, memory_paths, default_template_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, p.name, p.path, p.base_ref, p.deps_strategy, JSON.stringify(p.heavy_patterns), JSON.stringify(p.blocked_patterns), JSON.stringify(p.memory_paths), p.default_template_id, ts, ts);
    bus.changed('project');
    return { id, ...p };
  }
  updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'path'>>): Project | null {
    const cur = this.getProject(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare(`UPDATE projects SET name=?, base_ref=?, deps_strategy=?, heavy_patterns=?, blocked_patterns=?, memory_paths=?, default_template_id=?, updated_at=? WHERE id=?`)
      .run(n.name, n.base_ref, n.deps_strategy, JSON.stringify(n.heavy_patterns), JSON.stringify(n.blocked_patterns), JSON.stringify(n.memory_paths), n.default_template_id, nowIso(), id);
    bus.changed('project');
    return n;
  }
  deleteProject(id: string): boolean {
    const used = this.db.prepare("SELECT count(*) c FROM teams WHERE project_id = ? AND state NOT IN ('done','failed','archived')").get(id) as { c: number };
    if (used.c > 0) return false;
    this.db.prepare('UPDATE teams SET project_id = NULL WHERE project_id = ?').run(id);
    this.db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    bus.changed('project');
    return true;
  }

  /* ---------- templates ---------- */
  listTemplates(): TeamTemplate[] {
    return (this.db.prepare('SELECT * FROM team_templates ORDER BY builtin DESC, created_at').all() as { id: string; name: string; description: string; roles: string; builtin: number }[])
      .map((r) => ({ id: r.id, name: r.name, description: r.description, roles: parseJson<TemplateRole[]>(r.roles, []), builtin: !!r.builtin }));
  }
  getTemplate(id: string | null | undefined): TeamTemplate | null {
    if (!id) return null;
    return this.listTemplates().find((t) => t.id === id) ?? null;
  }
  upsertTemplate(t: Omit<TeamTemplate, 'builtin'> & { builtin?: boolean }): TeamTemplate {
    const ts = nowIso();
    this.db.prepare(`INSERT INTO team_templates (id, name, description, roles, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, roles = excluded.roles, updated_at = excluded.updated_at`)
      .run(t.id, t.name, t.description, JSON.stringify(t.roles), t.builtin ? 1 : 0, ts, ts);
    bus.changed('template');
    return { ...t, builtin: !!t.builtin };
  }
  deleteTemplate(id: string): void {
    this.db.prepare('DELETE FROM team_templates WHERE id = ? AND builtin = 0').run(id);
    bus.changed('template');
  }

  /* ---------- tasks ---------- */
  insertTask(t: { project_id: string | null; title: string; instruction: string; brief: string; priority: Priority; template_id: string | null; budget_usd: number | null }): TaskRow {
    const id = newId('t');
    const ts = nowIso();
    this.db.prepare(`INSERT INTO tasks (id, project_id, title, instruction, brief, priority, status, template_id, budget_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
      .run(id, t.project_id, t.title, t.instruction, t.brief, t.priority, t.template_id, t.budget_usd, ts, ts);
    return this.getTask(id)!;
  }
  getTask(id: string | null | undefined): TaskRow | null {
    if (!id) return null;
    return (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined) ?? null;
  }
  updateTask(id: string, patch: Partial<Pick<TaskRow, 'status' | 'priority' | 'brief' | 'finished_at' | 'budget_usd'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({ ...patch, updated_at: nowIso(), id });
  }

  /* ---------- proposals ---------- */
  insertProposal(p: Omit<ProposalView, 'id' | 'status' | 'task_id' | 'project_name' | 'template_name'>): ProposalView {
    const id = newId('pr');
    this.db.prepare(`INSERT INTO proposals (id, project_id, title, instruction, brief, template_id, roles, priority, budget_usd, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, p.project_id, p.title, p.instruction, p.brief, p.template_id, JSON.stringify(p.roles), p.priority, p.budget_usd, p.note, nowIso());
    bus.changed('proposal');
    return this.getProposal(id)!;
  }
  getProposal(id: string): ProposalView | null {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return r ? this.toProposalView(r) : null;
  }
  listProposals(status?: string): ProposalView[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 50').all(status)
      : this.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 50').all()) as ProposalRow[];
    return rows.map((r) => this.toProposalView(r));
  }
  updateProposal(id: string, patch: Partial<{ roles: TemplateRole[]; priority: Priority; project_id: string | null; budget_usd: number | null; brief: string; title: string; status: string; task_id: string }>): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); vals.push(k === 'roles' ? JSON.stringify(v) : v); }
    if (patch.status && patch.status !== 'pending') { cols.push('decided_at = ?'); vals.push(nowIso()); }
    if (!cols.length) return;
    this.db.prepare(`UPDATE proposals SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
    bus.changed('proposal');
  }
  private toProposalView(r: ProposalRow): ProposalView {
    return {
      id: r.id, project_id: r.project_id, project_name: this.getProject(r.project_id)?.name ?? null, title: r.title, instruction: r.instruction, brief: r.brief,
      template_id: r.template_id, template_name: this.getTemplate(r.template_id)?.name ?? null, roles: parseJson<TemplateRole[]>(r.roles, []),
      priority: r.priority, budget_usd: r.budget_usd, note: r.note, status: r.status, task_id: r.task_id,
    };
  }

  /* ---------- teams ---------- */
  insertTeam(t: Partial<TeamRow> & { name: string }): TeamRow {
    const id = t.id ?? newId(t.lifetime === 'standing' ? 's' : 'tm');
    const ts = nowIso();
    this.db.prepare(`INSERT INTO teams (id, task_id, project_id, name, managed_by, lifetime, standing_brief, check_command, check_interval_sec, readable_team_ids, worktree_path, branch, base_sha, state, stage, pinned, priority, budget_usd, created_at, updated_at)
      VALUES (@id, @task_id, @project_id, @name, @managed_by, @lifetime, @standing_brief, @check_command, @check_interval_sec, @readable_team_ids, @worktree_path, @branch, @base_sha, @state, 0, @pinned, @priority, @budget_usd, @ts, @ts)`).run({
      id, task_id: t.task_id ?? null, project_id: t.project_id ?? null, name: t.name, managed_by: t.managed_by ?? 'po', lifetime: t.lifetime ?? 'task',
      standing_brief: t.standing_brief ?? '', check_command: t.check_command ?? null, check_interval_sec: t.check_interval_sec ?? null,
      readable_team_ids: t.readable_team_ids ?? '[]', worktree_path: t.worktree_path ?? null, branch: t.branch ?? null, base_sha: t.base_sha ?? null,
      state: t.state ?? 'queued', pinned: t.pinned ?? 0, priority: t.priority ?? 'normal', budget_usd: t.budget_usd ?? null, ts,
    });
    bus.changed('team');
    return this.getTeam(id)!;
  }
  getTeam(id: string | null | undefined): TeamRow | null {
    if (!id) return null;
    return (this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined) ?? null;
  }
  listTeams(where = "state != 'archived'"): TeamRow[] {
    return this.db.prepare(`SELECT * FROM teams WHERE ${where} ORDER BY created_at DESC`).all() as TeamRow[];
  }
  updateTeam(id: string, patch: Partial<TeamRow>): TeamRow | null {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length) {
      this.db.prepare(`UPDATE teams SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__ts WHERE id = @__id`).run({ ...patch, __ts: nowIso(), __id: id });
      bus.changed('team');
    }
    return this.getTeam(id);
  }
  addTeamCost(id: string, usd: number): void {
    if (!usd) return;
    this.db.prepare('UPDATE teams SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?').run(usd, nowIso(), id);
  }
  touchTeam(id: string): void {
    this.db.prepare('UPDATE teams SET last_activity_at = ? WHERE id = ?').run(nowIso(), id);
  }

  /* ---------- agents ---------- */
  insertAgent(a: { team_id: string | null; role_key: string; role_name: string; model: Model; run_mode: RunMode; parent_agent_id?: string | null; system_prompt: string; allowed_tools: string[] }): AgentRow {
    const id = newId('a');
    const ts = nowIso();
    this.db.prepare(`INSERT INTO agents (id, team_id, role_key, role_name, model, run_mode, parent_agent_id, system_prompt, allowed_tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, a.team_id, a.role_key, a.role_name, a.model, a.run_mode, a.parent_agent_id ?? null, a.system_prompt, JSON.stringify(a.allowed_tools), ts, ts);
    return this.getAgent(id)!;
  }
  getAgent(id: string | null | undefined): AgentRow | null {
    if (!id) return null;
    return (this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined) ?? null;
  }
  teamAgents(teamId: string): AgentRow[] {
    return this.db.prepare('SELECT * FROM agents WHERE team_id = ? ORDER BY created_at, rowid').all(teamId) as AgentRow[];
  }
  agentByRole(teamId: string, roleKey: string): AgentRow | null {
    return (this.db.prepare('SELECT * FROM agents WHERE team_id = ? AND role_key = ?').get(teamId, roleKey) as AgentRow | undefined) ?? null;
  }
  poAgent(): AgentRow | null {
    return (this.db.prepare("SELECT * FROM agents WHERE team_id IS NULL AND role_key = 'po'").get() as AgentRow | undefined) ?? null;
  }
  updateAgent(id: string, patch: Partial<AgentRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    this.db.prepare(`UPDATE agents SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__ts WHERE id = @__id`).run({ ...patch, __ts: nowIso(), __id: id });
    bus.changed('agent');
  }
  addAgentUsage(id: string, u: { cost: number; inTok: number; outTok: number; context: number }): void {
    this.db.prepare('UPDATE agents SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, context_tokens = ?, updated_at = ? WHERE id = ?')
      .run(u.cost, u.inTok, u.outTok, u.context, nowIso(), id);
  }

  /* ---------- messages / events / runs ---------- */
  addMessage(m: { team_id: string | null; from_label: string; to_label?: string | null; kind: string; body: string }): number {
    const team = this.getTeam(m.team_id);
    const r = this.db.prepare('INSERT INTO messages (project_id, task_id, team_id, from_label, to_label, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(team?.project_id ?? null, team?.task_id ?? null, m.team_id, m.from_label, m.to_label ?? null, m.kind, m.body, nowIso());
    const id = Number(r.lastInsertRowid);
    this.index('message', String(id), m.body, team);
    bus.changed('message');
    return id;
  }
  addAgentEvent(e: { agent_id: string; team_id: string | null; kind: string; name?: string | null; body: string }): AgentEventRow {
    const ts = nowIso();
    const r = this.db.prepare('INSERT INTO agent_events (agent_id, team_id, kind, name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(e.agent_id, e.team_id, e.kind, e.name ?? null, e.body, ts);
    const row: AgentEventRow = { id: Number(r.lastInsertRowid), agent_id: e.agent_id, team_id: e.team_id, kind: e.kind, name: e.name ?? null, body: e.body, created_at: ts };
    bus.emitEvent({ type: 'agent_event', agentId: e.agent_id, teamId: e.team_id, event: row });
    return row;
  }
  startRun(r: { agent_id: string; team_id: string | null; tool_use_id: string; tool: string; command: string | null }): void {
    this.db.prepare("INSERT INTO runs (agent_id, team_id, tool_use_id, tool, command, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)").run(r.agent_id, r.team_id, r.tool_use_id, r.tool, r.command, nowIso());
  }
  endRun(toolUseId: string, status: 'ok' | 'error' | 'denied', waitedMs?: number): void {
    this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, waited_ms = waited_ms + ? WHERE tool_use_id = ? AND status = 'running'").run(status, nowIso(), waitedMs ?? 0, toolUseId);
  }
  addRunWait(toolUseId: string, ms: number): void {
    this.db.prepare('UPDATE runs SET waited_ms = waited_ms + ? WHERE tool_use_id = ?').run(ms, toolUseId);
  }

  /* ---------- checklist ---------- */
  setChecklist(teamId: string, items: string[]): void {
    const ts = nowIso();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM checklist WHERE team_id = ?').run(teamId);
      const ins = this.db.prepare('INSERT INTO checklist (team_id, idx, text, done, updated_at) VALUES (?, ?, ?, 0, ?)');
      items.forEach((t, i) => ins.run(teamId, i, t, ts));
    })();
    bus.changed('checklist');
  }
  addChecklistItem(teamId: string, text: string): void {
    const n = (this.db.prepare('SELECT coalesce(max(idx), -1) + 1 n FROM checklist WHERE team_id = ?').get(teamId) as { n: number }).n;
    this.db.prepare('INSERT INTO checklist (team_id, idx, text, done, updated_at) VALUES (?, ?, ?, 0, ?)').run(teamId, n, text, nowIso());
    bus.changed('checklist');
  }
  checkItem(teamId: string, idx: number, done: boolean): boolean {
    const r = this.db.prepare('UPDATE checklist SET done = ?, updated_at = ? WHERE team_id = ? AND idx = ?').run(done ? 1 : 0, nowIso(), teamId, idx);
    bus.changed('checklist');
    return r.changes > 0;
  }
  checklist(teamId: string): { idx: number; text: string; done: boolean }[] {
    return (this.db.prepare('SELECT idx, text, done FROM checklist WHERE team_id = ? ORDER BY idx').all(teamId) as { idx: number; text: string; done: number }[]).map((r) => ({ ...r, done: !!r.done }));
  }

  /* ---------- file changes / summaries ---------- */
  replaceFileChanges(teamId: string, rows: { path: string; change_type: string; lines_added: number; lines_removed: number }[]): void {
    const team = this.getTeam(teamId);
    const ts = nowIso();
    const key = (r: { path: string; change_type: string; lines_added: number; lines_removed: number }) => `${r.path}|${r.change_type}|${r.lines_added}|${r.lines_removed}`;
    const old = new Map(this.teamFiles(teamId).map((r) => [r.path, key(r)]));
    const next = new Map(rows.map((r) => [r.path, key(r)]));
    const changed = rows.filter((r) => old.get(r.path) !== key(r));
    const gone = [...old.keys()].filter((p) => old.get(p) !== next.get(p));
    if (!changed.length && !gone.length) return;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM file_changes WHERE team_id = ?').run(teamId);
      const ins = this.db.prepare('INSERT INTO file_changes (project_id, task_id, team_id, path, change_type, lines_added, lines_removed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(team?.project_id ?? null, team?.task_id ?? null, teamId, r.path, r.change_type, r.lines_added, r.lines_removed, ts);
      for (const p of gone) this.unindex('file', `${teamId}:${p}`);
    })();
    for (const r of changed) this.index('file', `${teamId}:${r.path}`, `${r.path} (${r.change_type} +${r.lines_added} -${r.lines_removed})`, team);
    bus.changed('files');
  }

  /** 검색 색인에서 지운다(FTS·벡터·위치 표). */
  unindex(sourceType: string, sourceId: string): void {
    const rows = this.db.prepare('SELECT rowid FROM fts_map WHERE source_type = ? AND source_id = ?').all(sourceType, sourceId) as { rowid: number }[];
    for (const r of rows) {
      this.db.prepare('DELETE FROM search_fts WHERE rowid = ?').run(r.rowid);
      try { this.db.prepare('DELETE FROM search_vec WHERE rowid = ?').run(BigInt(r.rowid)); } catch { /* 벡터 표가 없을 수 있다 */ }
      this.db.prepare('DELETE FROM fts_map WHERE rowid = ?').run(r.rowid);
    }
  }

  /** 보관 기간: 끝난 지 오래된 팀의 세부 기록과 처리된 PO 사건을 지운다(요약·대화·변경 기록은 남긴다). */
  prune(days = 14): { events: number; runs: number; poEvents: number } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const old = "SELECT id FROM teams WHERE state IN ('done','failed','archived') AND coalesce(finished_at, updated_at) < @cutoff";
    const r1 = this.db.prepare(`DELETE FROM agent_events WHERE (team_id IN (${old})) OR (team_id IS NULL AND created_at < @cutoff)`).run({ cutoff });
    const r2 = this.db.prepare(`DELETE FROM runs WHERE (team_id IN (${old})) OR (team_id IS NULL AND started_at < @cutoff)`).run({ cutoff });
    const r3 = this.db.prepare('DELETE FROM po_events WHERE handled_at IS NOT NULL AND created_at < @cutoff').run({ cutoff });
    return { events: r1.changes, runs: r2.changes, poEvents: r3.changes };
  }
  teamFiles(teamId: string): { path: string; change_type: string; lines_added: number; lines_removed: number }[] {
    return this.db.prepare('SELECT path, change_type, lines_added, lines_removed FROM file_changes WHERE team_id = ? ORDER BY path').all(teamId) as { path: string; change_type: string; lines_added: number; lines_removed: number }[];
  }
  addSummary(s: { team_id: string | null; agent_id?: string | null; stage: string; body: string }): void {
    const team = this.getTeam(s.team_id);
    const r = this.db.prepare('INSERT INTO work_summaries (project_id, task_id, team_id, agent_id, stage, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(team?.project_id ?? null, team?.task_id ?? null, s.team_id, s.agent_id ?? null, s.stage, s.body, nowIso());
    this.index('summary', String(r.lastInsertRowid), `[${s.stage}] ${s.body}`, team);
  }
  summaries(teamId: string, limit = 50): { stage: string; body: string; created_at: string }[] {
    return this.db.prepare('SELECT stage, body, created_at FROM work_summaries WHERE team_id = ? ORDER BY id DESC LIMIT ?').all(teamId, limit) as { stage: string; body: string; created_at: string }[];
  }

  /** 검색 색인(FTS5). 벡터 색인은 search 모듈이 따로 붙인다. */
  index(sourceType: string, sourceId: string, text: string, team: TeamRow | null): void {
    if (!text.trim()) return;
    const r = this.db.prepare('INSERT INTO search_fts (text, source_type, source_id, project_id, task_id, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(text, sourceType, sourceId, team?.project_id ?? null, team?.task_id ?? null, team?.id ?? null, nowIso());
    this.db.prepare('INSERT INTO fts_map (rowid, source_type, source_id, team_id) VALUES (?, ?, ?, ?)').run(r.lastInsertRowid, sourceType, sourceId, team?.id ?? null);
    bus.emit('indexed', { sourceType, sourceId, text, teamId: team?.id ?? null, projectId: team?.project_id ?? null });
  }

  /* ---------- PO 학습 ---------- */
  listKnowledge(): KnowledgeView[] {
    return this.db.prepare("SELECT * FROM po_knowledge ORDER BY kind DESC, name").all() as KnowledgeView[];
  }
  knowledgeCount(): number { return (this.db.prepare('SELECT count(*) n FROM po_knowledge').get() as { n: number }).n; }
  getKnowledge(idOrName: string): KnowledgeView | null {
    return (this.db.prepare('SELECT * FROM po_knowledge WHERE id = ? OR name = ?').get(idOrName, idOrName) as KnowledgeView | undefined) ?? null;
  }
  /** 같은 이름이면 고쳐 쓴다. */
  saveKnowledge(k: { kind: 'skill' | 'note'; name: string; when_to_use?: string; body: string; source?: string }): { row: KnowledgeView; created: boolean } {
    const cur = this.getKnowledge(k.name);
    const ts = nowIso();
    if (cur) {
      this.db.prepare('UPDATE po_knowledge SET kind = ?, when_to_use = ?, body = ?, source = ?, updated_at = ? WHERE id = ?').run(k.kind, k.when_to_use ?? cur.when_to_use, k.body, k.source ?? cur.source, ts, cur.id);
    } else {
      this.db.prepare('INSERT INTO po_knowledge (id, kind, name, when_to_use, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId('k'), k.kind, k.name, k.when_to_use ?? '', k.body, k.source ?? '', ts, ts);
    }
    const row = this.getKnowledge(k.name)!;
    this.unindex('knowledge', row.id);
    this.index('knowledge', row.id, `[PO ${row.kind === 'skill' ? '스킬' : '메모'}] ${row.name}: ${row.when_to_use}\n${row.body}`, null);
    bus.changed('knowledge');
    return { row, created: !cur };
  }
  updateKnowledge(id: string, patch: Partial<Pick<KnowledgeView, 'name' | 'when_to_use' | 'body' | 'kind'>>): KnowledgeView | null {
    const cur = this.getKnowledge(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE po_knowledge SET kind = ?, name = ?, when_to_use = ?, body = ?, updated_at = ? WHERE id = ?').run(n.kind, n.name, n.when_to_use, n.body, nowIso(), cur.id);
    const row = this.getKnowledge(cur.id)!;
    this.unindex('knowledge', row.id);
    this.index('knowledge', row.id, `[PO ${row.kind === 'skill' ? '스킬' : '메모'}] ${row.name}: ${row.when_to_use}\n${row.body}`, null);
    bus.changed('knowledge');
    return row;
  }
  deleteKnowledge(idOrName: string): boolean {
    const cur = this.getKnowledge(idOrName);
    if (!cur) return false;
    this.db.prepare('DELETE FROM po_knowledge WHERE id = ?').run(cur.id);
    this.unindex('knowledge', cur.id);
    bus.changed('knowledge');
    return true;
  }
  touchKnowledge(id: string): void { this.db.prepare('UPDATE po_knowledge SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(nowIso(), id); }

  /* ---------- PO ---------- */
  addPoEvent(type: string, teamId: string | null, payload: Record<string, unknown> = {}): number {
    const team = this.getTeam(teamId);
    const r = this.db.prepare('INSERT INTO po_events (type, team_id, task_id, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(type, teamId, team?.task_id ?? null, JSON.stringify(payload), nowIso());
    bus.emit('po_event', Number(r.lastInsertRowid));
    return Number(r.lastInsertRowid);
  }
  pendingPoEvents(): { id: number; type: string; team_id: string | null; task_id: string | null; payload: string; created_at: string }[] {
    return this.db.prepare('SELECT * FROM po_events WHERE handled_at IS NULL ORDER BY id').all() as { id: number; type: string; team_id: string | null; task_id: string | null; payload: string; created_at: string }[];
  }
  markPoEventsHandled(ids: number[]): void {
    const st = this.db.prepare('UPDATE po_events SET handled_at = ? WHERE id = ?');
    const ts = nowIso();
    this.db.transaction(() => ids.forEach((id) => st.run(ts, id)))();
  }
  addDecision(teamId: string | null, actor: 'engine' | 'agent' | 'user', action: string, reason: string): void {
    this.db.prepare('INSERT INTO po_decisions (team_id, actor, action, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(teamId, actor, action, reason, nowIso());
    bus.changed('decision');
  }
  addChat(c: { role: 'user' | 'po' | 'event'; body: string; proposal_id?: string | null; links?: { label: string; href: string }[]; tone?: string | null; team_id?: string | null }): ChatRow {
    const ts = nowIso();
    const r = this.db.prepare('INSERT INTO po_chat (role, body, proposal_id, links, tone, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.role, c.body, c.proposal_id ?? null, c.links ? JSON.stringify(c.links) : null, c.tone ?? null, c.team_id ?? null, ts);
    const row: ChatRow = { id: Number(r.lastInsertRowid), role: c.role, body: c.body, proposal_id: c.proposal_id ?? null, links: c.links ? JSON.stringify(c.links) : null, tone: c.tone ?? null, team_id: c.team_id ?? null, created_at: ts };
    bus.emitEvent({ type: 'chat', row });
    return row;
  }
  chat(limit = 200, beforeId?: number): ChatView[] {
    const rows = (beforeId
      ? this.db.prepare('SELECT * FROM po_chat WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
      : this.db.prepare('SELECT * FROM po_chat ORDER BY id DESC LIMIT ?').all(limit)) as ChatRow[];
    return rows.reverse().map(toChatView);
  }

  /* ---------- views ---------- */
  agentView(a: AgentRow): AgentView {
    return { id: a.id, team_id: a.team_id, role_key: a.role_key, role_name: a.role_name, model: a.model, run_mode: a.run_mode, state: a.state, current_step: a.current_step, cost_usd: a.cost_usd, tokens_in: a.tokens_in, tokens_out: a.tokens_out, session_id: a.session_id };
  }
  teamView(t: TeamRow): TeamView {
    const task = this.getTask(t.task_id);
    const agents = this.teamAgents(t.id).map((a) => this.agentView(a));
    const busy = agents.find((a) => a.state === 'busy');
    return {
      id: t.id, task_id: t.task_id, project_id: t.project_id, project_name: this.getProject(t.project_id)?.name ?? null, name: t.name, title: task?.title ?? t.name,
      managed_by: t.managed_by, lifetime: t.lifetime, state: t.state, stage: t.stage, priority: t.priority, pinned: !!t.pinned, paused_reason: t.paused_reason,
      question: parseJson(t.question, null), cost_usd: t.cost_usd, budget_usd: t.budget_usd, branch: t.branch, worktree_path: t.worktree_path, error: t.error,
      started_at: t.started_at, finished_at: t.finished_at, created_at: t.created_at, last_activity_at: t.last_activity_at, last_heartbeat_at: t.last_heartbeat_at,
      revived_count: t.revived_count, standing_brief: t.standing_brief, check_command: t.check_command, check_interval_sec: t.check_interval_sec,
      last_check_at: t.last_check_at, last_check_ok: t.last_check_ok == null ? null : !!t.last_check_ok, readable_team_ids: parseJson<string[]>(t.readable_team_ids, []), agents,
      busy_note: busy ? `${busy.role_name}: ${busy.current_step}` : null,
    };
  }
  teamDetail(id: string): TeamDetail | null {
    const t = this.getTeam(id);
    if (!t) return null;
    return {
      team: this.teamView(t),
      messages: this.db.prepare('SELECT id, from_label, to_label, kind, body, created_at FROM messages WHERE team_id = ? ORDER BY id DESC LIMIT 300').all(id).reverse() as TeamDetail['messages'],
      checklist: this.checklist(id),
      files: this.teamFiles(id),
      decisions: this.db.prepare('SELECT id, actor, action, reason, created_at FROM po_decisions WHERE team_id = ? ORDER BY id DESC LIMIT 100').all(id) as TeamDetail['decisions'],
      summaries: this.summaries(id, 30),
    };
  }
  agentDetail(id: string): AgentDetail | null {
    const a = this.getAgent(id);
    if (!a) return null;
    return {
      agent: { ...this.agentView(a), system_prompt: a.system_prompt, allowed_tools: parseJson<string[]>(a.allowed_tools, []) },
      events: (this.db.prepare('SELECT id, kind, name, body, created_at FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT 400').all(id) as AgentDetail['events']).reverse(),
      runs: this.db.prepare('SELECT id, tool, command, status, waited_ms, started_at, ended_at FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 200').all(id) as AgentDetail['runs'],
    };
  }

  /* ---------- push ---------- */
  addPushSub(endpoint: string, keys: unknown, device: string): void {
    this.db.prepare('INSERT INTO push_subscriptions (endpoint, keys, device, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, device = excluded.device').run(endpoint, JSON.stringify(keys), device, nowIso());
  }
  pushSubs(): { endpoint: string; keys: string }[] {
    return this.db.prepare('SELECT endpoint, keys FROM push_subscriptions').all() as { endpoint: string; keys: string }[];
  }
  removePushSub(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  /* ---------- resource samples ---------- */
  addSample(s: { cpu: number; mem: number; load: number; zone: string; perTeam: Record<string, unknown> }): void {
    this.db.prepare('INSERT INTO resource_samples (taken_at, cpu_pct, mem_pct, load_avg, zone, per_team) VALUES (?, ?, ?, ?, ?, ?)').run(nowIso(), s.cpu, s.mem, s.load, s.zone, JSON.stringify(s.perTeam));
  }
  pruneSamples(): void {
    this.db.prepare("DELETE FROM resource_samples WHERE taken_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')").run();
  }
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id, name: r.name, path: r.path, base_ref: r.base_ref, deps_strategy: r.deps_strategy as Project['deps_strategy'],
    heavy_patterns: parseJson(r.heavy_patterns, []), blocked_patterns: parseJson(r.blocked_patterns, []), memory_paths: parseJson(r.memory_paths, []), default_template_id: r.default_template_id,
  };
}
function toChatView(r: ChatRow): ChatView {
  return { id: r.id, role: r.role as ChatView['role'], body: r.body, proposal_id: r.proposal_id, links: parseJson(r.links, []), tone: r.tone, team_id: r.team_id, created_at: r.created_at };
}

export const BUILTIN_TEMPLATES: TeamTemplate[] = [
  { id: 'tpl-dev', name: '기본 개발팀', description: '기능 개발·버그 수정', builtin: true, roles: [
    { key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm' },
    { key: 'dev', name: '개발', model: 'sonnet', mode: 'subagent', tools: 'write' },
    { key: 'qa', name: 'QA', model: 'sonnet', mode: 'subagent', tools: 'verify' }] },
  { id: 'tpl-big', name: '큰 기능 팀', description: '되돌림이 잦은 큰 작업 · 개발 기억 유지', builtin: true, roles: [
    { key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm' },
    { key: 'dev', name: '개발', model: 'sonnet', mode: 'session', tools: 'write' },
    { key: 'qa', name: 'QA', model: 'sonnet', mode: 'subagent', tools: 'verify' },
    { key: 'review', name: '리뷰어', model: 'opus', mode: 'subagent', tools: 'read' }] },
  { id: 'tpl-research', name: '조사팀', description: '원인 분석·코드 탐색 (쓰기 없음)', builtin: true, roles: [
    { key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm' },
    { key: 'explore', name: '탐색', model: 'haiku', mode: 'subagent', tools: 'read' }] },
  { id: 'tpl-ops', name: '운영 점검팀', description: '직속 팀용 · 읽기와 점검 명령만', builtin: true, roles: [
    { key: 'pm', name: 'PM', model: 'sonnet', mode: 'session', tools: 'pm' },
    { key: 'ops', name: '점검', model: 'sonnet', mode: 'subagent', tools: 'verify' }] },
];

export function seedTemplates(store: Store): void {
  const have = new Set(store.listTemplates().map((t) => t.id));
  for (const t of BUILTIN_TEMPLATES) if (!have.has(t.id)) store.upsertTemplate(t);
}
