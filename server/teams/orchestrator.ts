import { forAgent } from '../uploads.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from '../config.ts';
import { bus } from '../bus.ts';
import { logger } from '../log.ts';
import type { Notifier } from '../notify/index.ts';
import { addWorktree, collectChanges, prepareDeps, removeWorktree, slug } from '../projects/git.ts';
import { saveWorktreePatch } from '../projects/archive.ts';
import { effectiveBlocked, splitApproval, type AgentRow, type Store, type TeamRow } from '../store.ts';
import { nowIso, parseJson, truncate } from '../util.ts';
import { descendants, listProcs, signalTree } from '../po/resources.ts';
import { pmPrompt, rolePrompt } from '../agents/prompts.ts';
import { presetTools, TurnHandle, type TurnResult, type TurnSpec } from '../agents/runner.ts';
import type { HeavySlots } from '../po/slots.ts';
import { expandGrant, teamMcpServer, teamToolNames, type TeamTools } from './tools.ts';
import { isSolo, type Priority, type Project, type TemplateRole } from '../../shared/types.ts';

const log = logger('team');

/** 지금 상태에서는 할 수 없는 요청(HTTP 409) */
export class ConflictError extends Error {}

/** node_modules 를 메인 트리와 공유할 때 막는 의존성 변경 명령 */
export const DEPS_MUTATE = ['\\b(npm|pnpm|yarn|bun)\\s+(i|ci|install|add|remove|uninstall|rm|un|update|up|upgrade|link|prune|dedupe)\\b'];

export interface TurnRunner { runTurn(spec: TurnSpec, handle: TurnHandle): Promise<TurnResult> }

interface Live {
  handle: TurnHandle | null;
  subHandles: Set<TurnHandle>;
  loop: Promise<void> | null;
  pending: string[];
  reported: { status: 'done' | 'failed'; summary: string } | null;
  asked: { question: string; options: string[]; kind?: 'approval' | 'tools'; command?: string; tools?: string[] } | null;
  /** 사람이 승인한 명령(한 번 실행하면 소진) */
  approved: Set<string>;
  pausePending: boolean;
  hardPaused: boolean;
  errors: number;
  overlapsSent: Set<string>;
  /** worktree·의존성 준비 중(루프는 아직 없음) */
  starting: boolean;
  /** 사용자가 진행 중인 지시를 취소함 */
  cancelled: boolean;
}

const MAX_NUDGES = 3;
const MAX_ERROR_RETRY = 2;

export class Orchestrator {
  private live = new Map<string, Live>();
  constructor(private deps: { cfg: AppConfig; store: Store; runner: TurnRunner; slots: HeavySlots; notifier: Notifier }) {}

  private L(teamId: string): Live {
    let l = this.live.get(teamId);
    if (!l) { l = { handle: null, subHandles: new Set(), loop: null, pending: [], reported: null, asked: null, pausePending: false, hardPaused: false, errors: 0, overlapsSent: new Set(), starting: false, cancelled: false, approved: new Set() }; this.live.set(teamId, l); }
    return l;
  }
  isRunning(teamId: string): boolean { const l = this.live.get(teamId); return !!(l?.loop || l?.starting); }
  isPausePending(teamId: string): boolean { return !!this.live.get(teamId)?.pausePending; }
  isHardPaused(teamId: string): boolean { return !!this.live.get(teamId)?.hardPaused; }
  rootPids(teamId: string): number[] {
    const l = this.live.get(teamId);
    if (!l) return [];
    return [l.handle?.pid, ...[...l.subHandles].map((h) => h.pid)].filter((p): p is number => typeof p === 'number');
  }
  async idle(): Promise<void> { await Promise.all([...this.live.values()].map((l) => l.loop).filter(Boolean)); }

  /* ================= 생성 ================= */

  /** 승인된 제안으로 업무·팀·팀원을 만든다. 시작은 엔진이 한다(queued). */
  createFromProposal(proposalId: string, override: { roles?: TemplateRole[]; priority?: Priority; project_id?: string | null; budget_usd?: number | null } = {}): TeamRow {
    const { store } = this.deps;
    const p = store.getProposal(proposalId);
    if (!p) throw new Error('제안을 찾을 수 없습니다');
    if (p.status !== 'pending') throw new Error('이미 처리된 제안입니다');
    const roles = normalizeRoles(override.roles ?? p.roles);
    const projectId = override.project_id !== undefined ? override.project_id : p.project_id;
    const priority = override.priority ?? p.priority;
    const budget = override.budget_usd !== undefined ? override.budget_usd : p.budget_usd ?? store.getSettings().defaultBudgetUsd;
    if (projectId && !store.getProject(projectId)) throw new ConflictError('제안의 프로젝트가 등록되어 있지 않습니다. 카드에서 프로젝트를 고르세요.');
    return store.db.transaction(() => this.createFromProposalTx(proposalId, p, roles, projectId, priority, budget))();
  }

  private createFromProposalTx(proposalId: string, p: NonNullable<ReturnType<Store['getProposal']>>, roles: TemplateRole[], projectId: string | null, priority: Priority, budget: number | null): TeamRow {
    const { store } = this.deps;
    const task = store.insertTask({ project_id: projectId, title: p.title, instruction: p.instruction, brief: p.brief, priority, template_id: p.template_id, budget_usd: budget });
    const team = store.insertTeam({ task_id: task.id, project_id: projectId, name: p.title, managed_by: 'po', lifetime: 'task', state: 'queued', priority, budget_usd: budget });
    this.createAgents(team, roles, store.getProject(projectId), false, '');
    store.updateProposal(proposalId, { status: 'approved', task_id: task.id, roles, priority, project_id: projectId, budget_usd: budget });
    store.addMessage({ team_id: team.id, from_label: 'PO', to_label: 'PM', kind: 'instruction', body: p.brief });
    store.addDecision(team.id, 'user', 'approve', `팀 구성 승인 · ${roles.map((r) => `${r.name}(${r.model}${r.mode === 'session' && r.key !== 'pm' ? '·독립' : ''})`).join(', ')}`);
    store.addChat({ role: 'event', body: `「${p.title}」 팀 생성 · ${store.getProject(projectId)?.name ?? '프로젝트 없음'} · 대기열에 들어감`, team_id: team.id });
    return team;
  }

  createStanding(input: { name: string; project_id: string | null; template_id: string | null; roles?: TemplateRole[]; brief: string; check_command?: string | null; check_interval_sec?: number | null; readable_team_ids?: string[] }): TeamRow {
    const { store } = this.deps;
    const tplId = store.getTemplate(input.template_id) ? input.template_id : input.roles ? null : 'tpl-ops';
    const roles = normalizeRoles(input.roles ?? store.getTemplate(input.template_id)?.roles ?? store.getTemplate('tpl-ops')!.roles);
    const team = store.insertTeam({
      name: input.name, project_id: input.project_id, managed_by: 'user', lifetime: 'standing', standing_brief: input.brief, state: 'idle', priority: 'urgent',
      check_command: input.check_command || null, check_interval_sec: input.check_interval_sec || null, readable_team_ids: JSON.stringify(input.readable_team_ids ?? []),
    });
    this.createAgents(team, roles, store.getProject(input.project_id), true, input.brief);
    store.setKv(`standing_tpl:${team.id}`, tplId);
    store.updateTeam(team.id, { last_heartbeat_at: nowIso() });
    store.addDecision(team.id, 'user', 'create', '직속 팀 생성');
    return store.getTeam(team.id)!;
  }

  /** 직속 팀 수정. 프로젝트·템플릿을 바꾸면 작업 폴더를 정리(패치 보관)하고 팀원 대화를 새로 시작한다. */
  async updateStanding(teamId: string, patch: { name?: string; brief?: string; check_command?: string | null; check_interval_sec?: number | null; readable_team_ids?: string[]; project_id?: string | null; template_id?: string }, by = '사용자'): Promise<void> {
    const { store, cfg } = this.deps;
    const t = store.getTeam(teamId);
    if (!t || t.lifetime !== 'standing') throw new Error('직속 팀이 아닙니다');
    const curTpl = store.getKv<string | null>(`standing_tpl:${teamId}`, null);
    const projectChanged = patch.project_id !== undefined && (patch.project_id || null) !== t.project_id;
    const templateChanged = !!patch.template_id && patch.template_id !== curTpl;
    const newProjectId = projectChanged ? (patch.project_id || null) : t.project_id;
    const tpl = templateChanged ? store.getTemplate(patch.template_id!) : null;
    const actor = by === '총괄' ? 'agent' as const : 'user' as const;
    if (projectChanged || templateChanged) {
      if (this.isRunning(teamId) || t.state === 'running') throw new ConflictError('일하는 중에는 프로젝트·템플릿을 바꿀 수 없습니다. 멈추거나 끝난 뒤 바꾸세요.');
      if (projectChanged && newProjectId && !store.getProject(newProjectId)) throw new ConflictError('프로젝트를 찾을 수 없습니다');
      if (templateChanged && !tpl) throw new ConflictError('템플릿을 찾을 수 없습니다');
    }
    store.updateTeam(teamId, {
      ...(patch.name ? { name: patch.name } : {}), ...(patch.brief !== undefined ? { standing_brief: patch.brief } : {}),
      ...(patch.check_command !== undefined ? { check_command: patch.check_command || null } : {}),
      ...(patch.check_interval_sec !== undefined ? { check_interval_sec: patch.check_interval_sec || null } : {}),
      ...(patch.readable_team_ids ? { readable_team_ids: JSON.stringify(patch.readable_team_ids) } : {}),
    });
    if (projectChanged) {
      const oldP = store.getProject(t.project_id);
      // 프로젝트 워크트리였으면 archive 처럼 변경을 패치로 남기고 지운다(standingDir 폴더는 그대로 둔다)
      if (oldP && t.worktree_path) {
        const patchFile = await saveWorktreePatch(cfg, t.worktree_path, t.base_sha, t.id).catch((e) => { log.warn(`패치 저장 실패 ${teamId}`, e); return null; });
        await removeWorktree(oldP.path, t.worktree_path);
        store.addCleanupLog({ project_id: t.project_id, team_id: teamId, kind: 'worktree', target: t.worktree_path, branch: t.branch, by, discarded: false, patch_path: patchFile?.path ?? null, patch_files: patchFile?.files ?? 0, note: `프로젝트 변경으로 정리 · ${patchFile ? `변경 ${patchFile.files}개 파일을 패치로 보관` : '변경 없음'}` });
      }
      store.updateTeam(teamId, { project_id: newProjectId, worktree_path: null, branch: null, base_sha: null });
      store.addDecision(teamId, actor, 'project', `프로젝트 변경: ${oldP?.name ?? '없음'} → ${store.getProject(newProjectId)?.name ?? '없음'}`);
    }
    if (templateChanged && tpl) {
      const fresh = store.getTeam(teamId)!;
      this.rebuildAgents(fresh, normalizeRoles(tpl.roles));
      store.setKv(`standing_tpl:${teamId}`, tpl.id);
      store.addDecision(teamId, actor, 'template', `템플릿 변경: ${store.getTemplate(curTpl)?.name ?? curTpl ?? '알 수 없음'} → ${tpl.name}`);
    }
    if (projectChanged || templateChanged) {
      for (const a of store.teamAgents(teamId)) store.updateAgent(a.id, { session_id: null });
    }
    if (patch.brief !== undefined || projectChanged || templateChanged) this.refreshPrompts(store.getTeam(teamId)!);
    bus.changed('team');
  }

  /** 새 역할 구성으로 팀원을 맞춘다: PM 은 그대로 두고 고치며, 같은 역할 키는 고쳐 쓰고, 없어진 역할은 지우고, 새 역할은 만든다. */
  private rebuildAgents(team: TeamRow, roles: TemplateRole[]): void {
    const { store } = this.deps;
    const project = store.getProject(team.project_id);
    store.db.transaction(() => {
      const pmRole = roles.find((r) => r.key === 'pm')!;
      const pm = store.agentByRole(team.id, 'pm')!;
      store.updateAgent(pm.id, { role_name: pmRole.name, model: pmRole.model, session_id: null });
      const existing = new Map(store.teamAgents(team.id).filter((a) => a.role_key !== 'pm').map((a) => [a.role_key, a]));
      for (const r of roles.filter((r) => r.key !== 'pm')) {
        const fields = { role_name: r.name, model: r.model, run_mode: r.mode, parent_agent_id: r.mode === 'subagent' ? pm.id : null, system_prompt: rolePrompt(r, project), allowed_tools: JSON.stringify(presetTools(r.tools)), session_id: null };
        const a = existing.get(r.key);
        if (a) { store.updateAgent(a.id, fields); existing.delete(r.key); }
        else store.insertAgent({ team_id: team.id, role_key: r.key, role_name: r.name, model: r.model, run_mode: r.mode, parent_agent_id: fields.parent_agent_id, system_prompt: fields.system_prompt, allowed_tools: presetTools(r.tools) });
      }
      for (const a of existing.values()) store.deleteAgent(a.id);
      store.setKv(`roles:${team.id}`, roles);
    })();
  }

  private createAgents(team: TeamRow, roles: TemplateRole[], project: Project | null, standing: boolean, brief: string): void {
    const { store } = this.deps;
    const pmRole = roles.find((r) => r.key === 'pm')!;
    const pm = store.insertAgent({ team_id: team.id, role_key: 'pm', role_name: pmRole.name, model: pmRole.model, run_mode: 'session', system_prompt: pmPrompt({ roles, project, standing, standingBrief: brief }), allowed_tools: [] });
    for (const r of roles.filter((r) => r.key !== 'pm')) {
      store.insertAgent({ team_id: team.id, role_key: r.key, role_name: r.name, model: r.model, run_mode: r.mode, parent_agent_id: r.mode === 'subagent' ? pm.id : null, system_prompt: rolePrompt(r, project), allowed_tools: presetTools(r.tools) });
    }
    store.setKv(`roles:${team.id}`, roles);
  }

  /** 지시문은 만들 때 고정하지 않고 턴마다 현재 코드 기준으로 다시 만든다(오래 사는 직속 팀도 규칙 변경을 받는다). */
  private refreshPrompts(team: TeamRow): void {
    const { store } = this.deps;
    const roles = this.rolesOf(team.id);
    if (!roles.length) return;
    const project = store.getProject(team.project_id);
    for (const a of store.teamAgents(team.id)) {
      const want = a.role_key === 'pm'
        ? pmPrompt({ roles, project, standing: team.lifetime === 'standing', standingBrief: team.standing_brief ?? '' })
        : (() => { const r = roles.find((x) => x.key === a.role_key); return r ? rolePrompt(r, project) : a.system_prompt; })();
      if (want !== a.system_prompt) store.updateAgent(a.id, { system_prompt: want });
    }
  }

  /** 팀 작업 환경: 격리(기본) / 내 Claude Code 와 동일 */
  private envFor(team: TeamRow, project: Project | null): { envMine: boolean; blocked: string[]; approval?: TurnSpec['approval']; extraWritable: string[]; note: string } {
    const base = [...effectiveBlocked(project), ...(project?.deps_strategy === 'symlink' ? DEPS_MUTATE : [])];
    if (team.env_mode !== 'mine') return { envMine: false, blocked: base, extraWritable: [], note: '' };
    const { hard, approval } = splitApproval(base);
    const l = this.L(team.id);
    const memories = project ? project.memory_paths : this.deps.store.listProjects().flatMap((p) => p.memory_paths);
    return {
      envMine: true, blocked: hard, extraWritable: memories,
      approval: { patterns: approval, take: (cmd) => l.approved.delete(cmd) },
      note: `\n\n## 작업 환경: 사용자의 Claude Code 와 동일\n- 사용자 전역 설정·플러그인·스킬·MCP 도구를 쓸 수 있다. 프로젝트 메모리 폴더(${memories.join(', ') || '없음'})에 기억을 쓸 수 있다.\n- 운영 DB·배포·인프라 명령(${approval.join(' · ') || '없음'})은 mcp__hivelane__request_approval 로 사람 승인을 받은 뒤에만 실행된다. 승인 없이 실행하면 거부된다.\n- 외부 서비스(슬랙·노션·GitHub 등)에 글을 쓰거나 보내는 일은 사용자가 시켰을 때만 한다.`,
    };
  }

  /** 사람이 승인한 임시 도구(업무가 끝나면 회수) */
  grants(teamId: string): string[] {
    return this.deps.store.getKv<string[]>(`grant:${teamId}`, []);
  }

  private revokeGrants(teamId: string): void {
    const g = this.grants(teamId);
    if (!g.length) return;
    this.deps.store.setKv(`grant:${teamId}`, []);
    this.deps.store.addDecision(teamId, 'engine', 'revoke', `임시 권한 회수: ${g.join(', ')}`);
  }

  rolesOf(teamId: string): TemplateRole[] {
    return this.deps.store.getKv<TemplateRole[]>(`roles:${teamId}`, []);
  }

  /* ================= 시작·루프 ================= */

  /** 엔진이 부른다: queued → running. 서버 재시작 뒤 이어가기도 여기로 온다. */
  async start(teamId: string): Promise<void> {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team || this.isRunning(teamId)) return;
    store.updateTeam(teamId, { state: 'running', started_at: team.started_at ?? nowIso(), error: null, paused_reason: null, pause_kind: null });
    const pm = store.agentByRole(teamId, 'pm')!;
    const l = this.L(teamId);
    l.starting = true;
    l.errors = 0;
    try {
      await this.ensureWorkspace(teamId);
    } catch (e) {
      l.starting = false;
      const msg = e instanceof Error ? e.message : String(e);
      store.updateTeam(teamId, { state: 'failed', error: `작업 공간 준비 실패: ${msg}`, finished_at: nowIso() });
      store.addDecision(teamId, 'engine', 'fail', `작업 공간 준비 실패: ${msg}`);
      this.deps.notifier.send({ title: '팀 시작 실패', body: `${team.name}: ${msg}`, level: 'crit', url: `/#team-${teamId}` });
      return;
    }
    l.starting = false;
    const fresh = store.getTeam(teamId)!;
    // 준비하는 동안 중단·멈춤됐으면 시작하지 않는다
    if (fresh.state !== 'running' || fresh.pause_kind) { bus.changed('team'); return; }
    const task = store.getTask(fresh.task_id);
    const prompt = pm.session_id
      ? '서버가 다시 시작되어 이어서 진행한다. 할 일 목록과 지금까지의 진행을 확인하고 남은 일을 계속해라.'
      : `## 업무\n${task?.title ?? fresh.name}\n\n## 지시(brief)\n${task?.brief || task?.instruction || fresh.standing_brief}\n\n작업 디렉토리: ${fresh.worktree_path}\n먼저 set_plan 으로 할 일을 정해라.`;
    this.kick(teamId, prompt);
  }

  private async ensureWorkspace(teamId: string): Promise<void> {
    const { store, cfg } = this.deps;
    const team = store.getTeam(teamId)!;
    if (team.worktree_path) return;
    const project = store.getProject(team.project_id);
    const pm = store.agentByRole(teamId, 'pm')!;
    if (!project) {
      const dir = join(team.lifetime === 'standing' ? cfg.standingDir : join(cfg.worktreesDir, '_none'), team.id);
      mkdirSync(dir, { recursive: true });
      store.updateTeam(teamId, { worktree_path: dir });
      return;
    }
    store.updateAgent(pm.id, { state: 'busy', current_step: 'worktree 준비 중' });
    const key = team.task_id ?? team.id;
    const wt = await addWorktree(project.path, project.base_ref, join(cfg.worktreesDir, slug(project.name), key), `hivelane/${key}`);
    store.updateTeam(teamId, { worktree_path: wt.path, branch: wt.branch, base_sha: wt.baseSha });
    store.addDecision(teamId, 'engine', 'worktree', `${wt.branch} ← ${project.base_ref} (${wt.baseSha.slice(0, 8)})`);
    store.updateAgent(pm.id, { current_step: '의존성 준비 중' });
    const deps = await prepareDeps(project.path, wt.path, project.deps_strategy);
    const parts = [deps.linked.length && `링크 ${deps.linked.length}`, deps.installed.length && `설치 ${deps.installed.length}`, deps.failed.length && `실패 ${deps.failed.map((f) => f.dir).join(', ')}`].filter(Boolean);
    if (parts.length) store.addDecision(teamId, 'engine', 'deps', `node_modules ${parts.join(' · ')}`);
    store.updateAgent(pm.id, { state: 'idle', current_step: '시작 준비 완료' });
  }

  /** PM 턴 루프를 띄운다(이미 돌고 있으면 메시지로 쌓는다). */
  private kick(teamId: string, prompt: string): void {
    const l = this.L(teamId);
    if (l.loop) { l.pending.push(prompt); return; }
    l.reported = null; l.asked = null; l.pausePending = false;
    l.loop = this.loop(teamId, prompt).catch((e) => {
      log.error(`루프 예외 ${teamId}`, e);
      const t = this.deps.store.getTeam(teamId);
      if (t && t.state === 'running') {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.store.updateTeam(teamId, { state: t.lifetime === 'standing' ? 'down' : 'waiting_human', error: msg, question: JSON.stringify({ text: `내부 오류로 멈췄습니다: ${truncate(msg, 300)}`, options: ['다시 시도', '여기서 마무리'], asked_at: nowIso() }) });
      }
    }).finally(() => { l.loop = null; l.handle = null; bus.changed('team'); });
  }

  private async loop(teamId: string, firstPrompt: string): Promise<void> {
    const { store } = this.deps;
    const l = this.L(teamId);
    let prompt = firstPrompt;
    for (;;) {
      const team = store.getTeam(teamId);
      if (!team) return;
      const pm = store.agentByRole(teamId, 'pm')!;
      const handle = new TurnHandle();
      l.handle = handle;
      const resume = pm.session_id;
      const spec = this.pmSpec(team, pm, resume ? prompt : this.bootstrap(team) + prompt, resume);
      const res = await this.deps.runner.runTurn(spec, handle);
      l.handle = null;
      if (res.sessionId) store.updateAgent(pm.id, { session_id: res.sessionId });
      if (res.contextTokens > store.getSettings().contextLimitTokens) {
        store.updateAgent(pm.id, { session_id: null });
        store.addDecision(teamId, 'engine', 'rotate', `PM 맥락 ${Math.round(res.contextTokens / 1000)}k 토큰 → 다음 턴은 새 세션`);
      }
      await this.collect(teamId);
      const after = store.getTeam(teamId)!;

      if (l.cancelled) {
        l.cancelled = false; l.reported = null; l.asked = null; l.pausePending = false;
        store.addMessage({ team_id: teamId, from_label: 'PO 엔진', kind: 'engine', body: '사용자가 진행 중이던 지시를 취소함' });
        if (after.lifetime === 'standing') { store.updateTeam(teamId, { state: 'idle' }); this.revokeGrants(teamId); }
        else store.updateTeam(teamId, { state: 'waiting_human', question: JSON.stringify({ text: '진행 중이던 지시를 취소했습니다. 새로 지시하거나 이어서 진행할지 골라 주세요.', options: ['계속 진행', '여기서 마무리'], asked_at: nowIso() }) });
        return;
      }

      if (handle.pauseRequested || l.pausePending) {
        l.pausePending = false;
        store.updateTeam(teamId, { state: 'paused' });
        store.addMessage({ team_id: teamId, from_label: 'PO 엔진', kind: 'engine', body: `일시정지됨 · ${after.paused_reason ?? ''}` });
        return;
      }
      if (l.reported) {
        this.finish(teamId, l.reported);
        return;
      }
      if (l.asked) {
        const q = { text: l.asked.question, options: l.asked.options, asked_at: nowIso(), ...(l.asked.kind ? { kind: l.asked.kind, command: l.asked.command, tools: l.asked.tools } : {}) };
        store.updateTeam(teamId, { state: after.lifetime === 'standing' ? 'idle' : 'waiting_human', question: JSON.stringify(q) });
        store.addMessage({ team_id: teamId, from_label: 'PM', to_label: '사용자', kind: 'question', body: l.asked.question + (l.asked.options.length ? `\n선택지: ${l.asked.options.join(' / ')}` : '') });
        store.addPoEvent('ask_human', teamId, { question: l.asked.question });
        this.deps.notifier.send({ title: '사람 확인 필요', body: `${after.name}: ${l.asked.question}`, level: 'crit', url: `/#team-${teamId}`, tag: `ask-${teamId}`, scope: `team:${teamId}` });
        return;
      }
      if (res.subtype === 'error_max_budget_usd') {
        const q = { text: `예산 $${after.budget_usd ?? '-'} 에 도달했습니다. 계속할까요?`, options: ['예산 +50% 하고 계속', '여기서 마무리'], asked_at: nowIso(), kind: 'budget' };
        store.updateTeam(teamId, { state: 'waiting_human', question: JSON.stringify(q) });
        store.addPoEvent('budget', teamId, { budget: after.budget_usd });
        this.deps.notifier.send({ title: '예산 상한 도달', body: `${after.name} · $${after.cost_usd.toFixed(2)}`, level: 'warn', url: `/#team-${teamId}` });
        return;
      }
      if (!res.ok && !res.interrupted) {
        l.errors++;
        const err = res.error ?? res.subtype;
        store.addDecision(teamId, 'engine', 'error', `PM 턴 오류(${l.errors}회): ${truncate(err, 200)}`);
        if (after.lifetime === 'standing') {
          const revived = await this.revive(teamId, err);
          if (!revived) return;
          prompt = '오류로 끊겼다가 되살아났다. 하던 일을 이어서 진행해라.';
          continue;
        }
        if (l.errors <= MAX_ERROR_RETRY) { prompt = '직전 턴이 오류로 끊겼다. 할 일 목록을 확인하고 이어서 진행해라.'; continue; }
        const q = { text: `PM 실행이 계속 실패합니다: ${truncate(err, 300)}`, options: ['다시 시도', '여기서 마무리'], asked_at: nowIso() };
        store.updateTeam(teamId, { state: 'waiting_human', error: err, question: JSON.stringify(q) });
        store.addPoEvent('error', teamId, { error: err });
        this.deps.notifier.send({ title: '팀 오류', body: `${after.name}: ${truncate(err, 200)}`, level: 'crit', url: `/#team-${teamId}` });
        return;
      }
      l.errors = 0;
      if (l.pending.length) { prompt = l.pending.splice(0).join('\n\n'); continue; }
      if (after.lifetime === 'standing') {
        store.updateTeam(teamId, { state: 'idle' });
        this.revokeGrants(teamId);
        if (res.text.trim()) {
          const asker = this.askerOf(teamId);
          store.addMessage({ team_id: teamId, from_label: 'PM', to_label: asker.from === 'PO' ? 'PO' : '사용자', kind: 'report', body: res.text.trim() });
          if (asker.from === 'PO') store.addPoEvent('team_reply', teamId, { status: 'done', asked: truncate(asker.body, 300), answer: truncate(res.text.trim(), 2500) });
          this.deps.notifier.send({ title: `${after.name} 답변`, body: truncate(res.text.trim(), 300), level: 'good', url: `/#team-${teamId}`, tag: `ans-${teamId}`, scope: `team:${teamId}` });
        }
        store.addSummary({ team_id: teamId, agent_id: pm.id, stage: '보고', body: truncate(res.text.trim() || '(내용 없음)', 4000) });
        return;
      }
      if (after.nudges < MAX_NUDGES) {
        store.updateTeam(teamId, { nudges: after.nudges + 1 });
        prompt = '아직 report 를 호출하지 않았다. 남은 일을 계속하거나, 끝났으면 report 를 호출해라. 사람의 결정이 필요하면 ask_human 을 호출해라.';
        continue;
      }
      const q = { text: `PM이 report 없이 멈췄습니다. 마지막 말: ${truncate(res.text, 300)}`, options: ['계속 진행', '여기서 마무리'], asked_at: nowIso() };
      store.updateTeam(teamId, { state: 'waiting_human', question: JSON.stringify(q), nudges: 0 });
      store.addPoEvent('stall', teamId, { reason: 'no_report' });
      return;
    }
  }

  private bootstrap(team: TeamRow): string {
    const { store } = this.deps;
    const sums = store.summaries(team.id, 8).reverse();
    const items = store.checklist(team.id);
    const msgs = (store.teamDetail(team.id)?.messages ?? []).slice(-12);
    if (!sums.length && !items.length && msgs.length <= 1) return '';
    return `## 이전 진행 (새 세션으로 이어받음)
${team.lifetime === 'standing' ? `상시 지시서: ${team.standing_brief}\n` : ''}할 일:
${items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.idx}. ${i.text}`).join('\n') || '- (없음)'}
요약:
${sums.map((s) => `- [${s.stage}] ${truncate(s.body, 600)}`).join('\n') || '- (없음)'}
최근 대화:
${msgs.map((m) => `- ${m.from_label}→${m.to_label ?? ''} (${m.kind}): ${truncate(m.body, 300)}`).join('\n')}

`;
  }

  private pmSpec(team: TeamRow, pmIn: AgentRow, prompt: string, resume: string | null): TurnSpec {
    const { store, cfg } = this.deps;
    this.refreshPrompts(team);
    const pm = store.agentByRole(team.id, 'pm') ?? pmIn;
    const project = store.getProject(team.project_id);
    const roles = this.rolesOf(team.id);
    const sessionRoles = roles.filter((r) => r.key !== 'pm' && r.mode === 'session');
    const readable = parseJson<string[]>(team.readable_team_ids, []).length > 0;
    const impl = this.toolsFor(team.id);
    const granted = this.grants(team.id);
    const subagents: TurnSpec['subagents'] = {};
    for (const r of roles.filter((r) => r.key !== 'pm' && r.mode === 'subagent')) {
      const a = store.agentByRole(team.id, r.key)!;
      subagents[r.key] = { description: `${r.name} 담당`, prompt: a.system_prompt, model: r.model, tools: [...new Set([...presetTools(r.tools), ...granted])], roleAgentId: a.id, roleName: r.name } as AgentDefinition & { roleAgentId: string; roleName: string };
    }
    const wt = team.worktree_path ?? cfg.home;
    const l = this.L(team.id);
    // 프로젝트 없는 직속 팀은 등록된 프로젝트를 모두 읽을 수 있다(쓰기는 자기 폴더만)
    const readAll = team.lifetime === 'standing' && !project ? store.listProjects() : [];
    const readNote = readAll.length ? `\n\n## 읽을 수 있는 프로젝트(읽기 전용)\n${readAll.map((p) => `- ${p.name}: ${p.path}`).join('\n')}` : '';
    const env = this.envFor(team, project);
    return {
      agent: pm, team, prompt, cwd: wt, systemAppend: pm.system_prompt + readNote + env.note,
      allowedTools: [...new Set([...(isSolo(roles) ? [...presetTools('write'), 'Agent', 'WebFetch', 'WebSearch'] : presetTools(env.envMine ? 'write' : 'pm')), ...granted]), ...teamToolNames(sessionRoles.length > 0, readable, !!env.approval)],
      additionalDirectories: [...(project?.memory_paths ?? []), ...readAll.map((p) => p.path), cfg.uploadsDir],
      writableRoots: [wt, ...env.extraWritable],
      heavyPatterns: project?.heavy_patterns ?? [],
      blockedPatterns: env.blocked,
      envMine: env.envMine,
      approval: env.approval,
      mcpServers: { hivelane: teamMcpServer(impl, { sessionRoles: sessionRoles.map((r) => ({ key: r.key, name: r.name })), readableTeams: readable, approval: !!env.approval }) },
      toolsImpl: impl,
      subagents,
      resume,
      maxBudgetUsd: team.budget_usd ? Math.max(0.5, team.budget_usd - team.cost_usd) : null,
      priority: team.priority,
      standing: team.lifetime === 'standing',
      label: 'PM',
      injectContext: () => {
        if (!l.pending.length) return null;
        const msgs = l.pending.splice(0);
        return `사용자 직접 지시가 도착했다. 할 일 목록에 반영하고 따라라:\n${msgs.map((m) => `- ${m}`).join('\n')}`;
      },
    };
  }

  private toolsFor(teamId: string): TeamTools {
    const { store } = this.deps;
    const l = this.L(teamId);
    return {
      setPlan: (items) => { store.setChecklist(teamId, items); store.addSummary({ team_id: teamId, stage: '기획', body: items.map((x, i) => `${i}. ${x}`).join('\n') }); return `할 일 ${items.length}개를 정했다.`; },
      checkItem: (index, done) => (store.checkItem(teamId, index, done) ? `${index}번을 ${done ? '완료' : '미완료'}로 표시했다.` : `${index}번 할 일이 없다.`),
      setStage: (stage) => { store.updateTeam(teamId, { stage }); return `단계를 ${['기획', '구현', '검사', '보고'][stage]}(으)로 바꿨다.`; },
      askHuman: (question, options) => { l.asked = { question, options }; return '질문을 올렸다. 지금 턴을 끝내라. 답은 다음 메시지로 온다.'; },
      requestApproval: (command, reason) => {
        l.asked = { question: `이 명령을 실행해도 될까요?\n\n\`${command.trim()}\`\n\n이유: ${reason}`, options: ['승인', '거절'], kind: 'approval', command: command.trim() };
        return '승인을 요청했다. 지금 턴을 끝내라. 승인되면 다음 메시지로 알려 주니 같은 명령을 그대로 실행해라.';
      },
      requestTools: (tools, reason) => {
        const want = expandGrant(tools).filter((t) => t !== 'MultiEdit');
        if (!want.length) return '요청할 수 있는 도구가 없다(Bash·Edit·Write·NotebookEdit·WebFetch·WebSearch 중에서 고른다).';
        const standing = store.getTeam(teamId)?.lifetime === 'standing';
        l.asked = {
          question: `이 팀에 임시 권한을 줄까요?\n\n요청 도구: ${want.join(', ')}\n\n이유: ${reason}\n\n승인하면 ${standing ? '이번 지시가 끝날 때까지' : '이 업무가 끝날 때까지'} 팀 전체(PM·팀원)가 이 도구를 씁니다. 막힌 명령·운영 명령 승인 규칙과 쓰기 가능한 폴더는 그대로입니다.`,
          options: ['승인', '거절'], kind: 'tools', tools: want,
        };
        return '임시 권한을 요청했다. 지금 턴을 끝내라. 승인되면 다음 메시지부터 그 도구를 쓸 수 있다.';
      },
      report: (status, summary) => { l.reported = { status, summary }; return '보고를 받았다. 턴을 끝내라.'; },
      delegate: (roleKey, instruction) => this.delegate(teamId, roleKey, instruction),
      readTeamRecords: (otherId, q) => this.readTeamRecords(teamId, otherId, q),
    };
  }

  private async delegate(teamId: string, roleKey: string, instruction: string): Promise<string> {
    const { store, cfg } = this.deps;
    const l = this.L(teamId);
    const team = store.getTeam(teamId)!;
    const agent = store.agentByRole(teamId, roleKey);
    const role = this.rolesOf(teamId).find((r) => r.key === roleKey);
    if (!agent || !role) return `팀원 ${roleKey} 이(가) 없다.`;
    if (l.pausePending) return '팀이 일시정지 중이라 맡기지 않았다.';
    const project = store.getProject(team.project_id);
    const wt = team.worktree_path ?? cfg.home;
    store.addMessage({ team_id: teamId, from_label: 'PM', to_label: role.name, kind: 'handoff', body: instruction });
    const handle = new TurnHandle();
    l.subHandles.add(handle);
    try {
      const env = this.envFor(team, project);
      const res = await this.deps.runner.runTurn({
        agent, team, prompt: instruction, cwd: wt, systemAppend: agent.system_prompt + env.note, allowedTools: [...new Set([...presetTools(role.tools), ...this.grants(teamId)])],
        additionalDirectories: [...(project?.memory_paths ?? []), this.deps.cfg.uploadsDir], writableRoots: [wt, ...env.extraWritable], heavyPatterns: project?.heavy_patterns ?? [], blockedPatterns: env.blocked,
        envMine: env.envMine, approval: env.approval,
        resume: agent.session_id, priority: team.priority, standing: team.lifetime === 'standing', label: role.name,
        maxBudgetUsd: team.budget_usd ? Math.max(0.5, team.budget_usd - (store.getTeam(teamId)?.cost_usd ?? 0)) : null,
      }, handle);
      if (res.sessionId) store.updateAgent(agent.id, { session_id: res.sessionId });
      if (res.contextTokens > store.getSettings().contextLimitTokens) store.updateAgent(agent.id, { session_id: null });
      const text = res.ok ? res.text || '(내용 없음)' : `실패: ${res.error ?? res.subtype}${res.text ? `\n${res.text}` : ''}`;
      store.addMessage({ team_id: teamId, from_label: role.name, to_label: 'PM', kind: 'report', body: truncate(text, 6000) });
      store.addSummary({ team_id: teamId, agent_id: agent.id, stage: role.tools === 'verify' ? '검사' : '구현', body: truncate(text, 3000) });
      return handle.pauseRequested ? '팀이 일시정지되어 중단됐다. 턴을 끝내라.' : text;
    } finally {
      l.subHandles.delete(handle);
    }
  }

  private readTeamRecords(teamId: string, otherId: string, q: string): string {
    const { store } = this.deps;
    const allowed = parseJson<string[]>(store.getTeam(teamId)?.readable_team_ids, []);
    if (!allowed.includes(otherId)) return `팀 ${otherId} 의 기록은 읽을 수 없다(허용 목록: ${allowed.join(', ') || '없음'}).`;
    const d = store.teamDetail(otherId);
    if (!d) return '없는 팀이다.';
    const files = d.files.map((f) => `${f.path} (+${f.lines_added} -${f.lines_removed})`).join('\n');
    const msgs = d.messages.filter((m) => !q || m.body.includes(q)).slice(-15).map((m) => `${m.created_at} ${m.from_label}: ${truncate(m.body, 400)}`).join('\n');
    return `# ${d.team.title} (${d.team.state})\n## 요약\n${d.summaries.slice(0, 5).map((s) => `[${s.stage}] ${truncate(s.body, 500)}`).join('\n')}\n## 바뀐 파일\n${files || '(없음)'}\n## 대화\n${msgs}`;
  }

  /** 이번 일을 시킨 쪽: PM 에게 온 마지막 지시·답의 보낸 이 */
  private askerOf(teamId: string): { from: string; body: string } {
    const m = this.deps.store.db.prepare("SELECT from_label, body FROM messages WHERE team_id = ? AND to_label = 'PM' AND kind IN ('instruction','reply') ORDER BY id DESC LIMIT 1").get(teamId) as { from_label: string; body: string } | undefined;
    return { from: m?.from_label ?? '', body: m?.body ?? '' };
  }

  private finish(teamId: string, r: { status: 'done' | 'failed'; summary: string }): void {
    const { store } = this.deps;
    const team = store.getTeam(teamId)!;
    this.revokeGrants(teamId);
    store.addSummary({ team_id: teamId, stage: '최종', body: r.summary });
    // 보고 받는 쪽: 이번 일을 시킨 쪽(사용자가 직접 지시했으면 사용자, 아니면 총괄)
    const asker = this.askerOf(teamId);
    store.addMessage({ team_id: teamId, from_label: 'PM', to_label: asker.from === '사용자' ? '사용자' : 'PO', kind: 'report', body: r.summary });
    if (team.lifetime === 'standing') {
      store.updateTeam(teamId, { state: 'idle' });
      // 총괄이 맡긴 일의 답은 총괄에게 사건으로 넘겨 사용자에게 전하게 한다
      if (asker.from === 'PO') store.addPoEvent('team_reply', teamId, { status: r.status, asked: truncate(asker.body, 300), answer: truncate(r.summary, 2500) });
      this.deps.notifier.send({ title: `${team.name} 답변`, body: truncate(r.summary, 300), level: r.status === 'done' ? 'good' : 'warn', url: `/#team-${teamId}`, tag: `ans-${teamId}`, scope: `team:${teamId}` });
      return;
    }
    store.updateTeam(teamId, { state: r.status, stage: r.status === 'done' ? 4 : team.stage, finished_at: nowIso(), question: null });
    store.updateTask(team.task_id!, { status: r.status, finished_at: nowIso() });
    store.addDecision(teamId, 'agent', r.status, r.status === 'done' ? '업무 완료 보고' : '실패 보고');
    store.addPoEvent('report', teamId, { status: r.status, asked_by: asker.from, answer: truncate(r.summary, 2500) });
    this.deps.notifier.send({ title: r.status === 'done' ? '업무 완료' : '업무 실패', body: `${team.name}\n${truncate(r.summary, 300)}`, level: r.status === 'done' ? 'good' : 'crit', url: `/#team-${teamId}`, scope: `team:${teamId}` });
  }

  /** 턴이 끝날 때마다 변경 파일 수집 + 같은 프로젝트 팀과 겹침 확인. */
  private async collect(teamId: string): Promise<void> {
    const { store } = this.deps;
    const t = store.getTeam(teamId);
    if (!t?.worktree_path || !t.base_sha) return;
    try {
      const rows = await collectChanges(t.worktree_path, t.base_sha);
      store.replaceFileChanges(teamId, rows);
      if (!t.project_id || !rows.length) return;
      const mine = new Set(rows.map((r) => r.path));
      const l = this.L(teamId);
      for (const o of store.listTeams(`project_id = '${t.project_id.replace(/'/g, "''")}' AND id != '${teamId.replace(/'/g, "''")}' AND state IN ('running','paused','waiting_human','queued')`)) {
        const shared = store.teamFiles(o.id).map((f) => f.path).filter((p) => mine.has(p));
        const key = `${o.id}:${shared.sort().join(',')}`;
        if (shared.length && !l.overlapsSent.has(key)) {
          l.overlapsSent.add(key);
          store.addPoEvent('overlap', teamId, { other: o.id, files: shared.slice(0, 20) });
          store.addDecision(teamId, 'engine', 'overlap', `「${o.name}」 팀과 같은 파일 ${shared.length}개: ${shared.slice(0, 3).join(', ')}`);
        }
      }
    } catch (e) { log.warn(`변경 수집 실패 ${teamId}`, e); }
  }

  /* ================= 사람·엔진 조작 ================= */

  async pause(teamId: string, kind: 'engine-soft' | 'user', reason: string): Promise<void> {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) return;
    if (['done', 'failed', 'archived'].includes(team.state)) throw new ConflictError('끝난 팀은 멈출 수 없습니다');
    store.addDecision(teamId, kind === 'user' ? 'user' : 'engine', 'pause', reason);
    store.updateTeam(teamId, { paused_reason: reason, pause_kind: kind });
    const l = this.live.get(teamId);
    if (l?.hardPaused) await this.continueTree(teamId, '멈춤 요청 처리를 위해 강한 멈춤 해제');
    if (l?.loop) {
      l.pausePending = true;
      this.deps.slots.cancelTeam(teamId);
      await Promise.all([l.handle?.interrupt(), ...[...l.subHandles].map((h) => h.interrupt())]);
    } else if (['queued', 'waiting_human', 'running', 'idle', 'down', 'reviving'].includes(team.state) || l?.starting) {
      store.updateTeam(teamId, { state: 'paused' });
    }
    // 엔진 멈춤은 총괄을 깨우지 않는다(빨강 구간에 총괄 턴까지 돌면 부하만 늘어난다)
    if (kind !== 'user') this.deps.notifier.send({ title: '팀 일시정지', body: `${team.name}: ${reason}`, level: 'warn', url: `/#team-${teamId}`, tag: `pause-${teamId}` });
  }

  /** 강한 멈춤: 프로세스 트리 SIGSTOP. 엔진이 pids 를 넘긴다. */
  /** 강한 멈춤(SIGSTOP)된 프로세스 트리를 깨운다. */
  async continueTree(teamId: string, reason: string): Promise<void> {
    const procs = await listProcs();
    signalTree(descendants(procs, this.rootPids(teamId)), 'SIGCONT');
    this.markHardPaused(teamId, false, reason);
  }

  markHardPaused(teamId: string, on: boolean, reason: string): void {
    const l = this.L(teamId);
    l.hardPaused = on;
    this.deps.store.updateTeam(teamId, { pause_kind: on ? 'engine-hard' : 'engine-soft' });
    this.deps.store.addDecision(teamId, 'engine', on ? 'hard-pause' : 'hard-resume', reason);
  }

  /** 사람이 직접 재개한 팀은 15분 동안 엔진이 자동으로 멈추지 않는다(메모리 한계 제외). */
  private grace = new Map<string, number>();
  static readonly RESUME_GRACE_MS = 15 * 60_000;
  inGrace(teamId: string, now = Date.now()): boolean { const g = this.grace.get(teamId); return g !== undefined && now < g; }
  graceUntil(teamId: string): string | null { const g = this.grace.get(teamId); return g && Date.now() < g ? new Date(g).toISOString() : null; }

  async resume(teamId: string, by: 'engine' | 'user', reason = ''): Promise<void> {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) return;
    if (by === 'user') this.grace.set(teamId, Date.now() + Orchestrator.RESUME_GRACE_MS);
    const l = this.L(teamId);
    store.addDecision(teamId, by, 'resume', reason || '재개');
    store.updateTeam(teamId, { paused_reason: null, pause_kind: null });
    if (l.loop) { l.pausePending = false; if (l.handle) l.handle.pauseRequested = false; return; }
    if (team.state !== 'paused') return;
    if (team.question) { store.updateTeam(teamId, { state: team.lifetime === 'standing' ? 'idle' : 'waiting_human' }); return; }
    if (team.lifetime === 'standing') {
      store.updateTeam(teamId, { state: 'idle' });
      if (l.pending.length) this.wake(teamId, l.pending.splice(0).join('\n\n'));
      return;
    }
    const pm = store.agentByRole(teamId, 'pm');
    if (!team.started_at || !pm?.session_id) { store.updateTeam(teamId, { state: 'queued' }); return; }
    store.updateTeam(teamId, { state: 'running' });
    this.kick(teamId, '일시정지가 풀렸다. 할 일 목록을 확인하고 이어서 진행해라.');
  }

  answer(teamId: string, text: string): void {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) throw new Error('팀이 없습니다');
    if (!team.question || !['waiting_human', 'paused', 'idle', 'down'].includes(team.state) || this.isRunning(teamId)) throw new ConflictError('지금은 답할 질문이 없습니다');
    const q = parseJson<{ kind?: string; command?: string; tools?: string[] } | null>(team.question, null);
    this.L(teamId).errors = 0;
    store.addMessage({ team_id: teamId, from_label: '사용자', to_label: 'PM', kind: 'reply', body: text });
    store.addDecision(teamId, 'user', 'answer', truncate(text, 200));
    if (q?.kind === 'budget') {
      if (text.includes('마무리')) { store.updateTeam(teamId, { question: null }); this.finish(teamId, { status: 'failed', summary: `예산 상한에서 사용자가 마무리를 선택했다. 지금까지 사용 $${team.cost_usd.toFixed(2)}` }); return; }
      store.updateTeam(teamId, { budget_usd: Math.round((team.budget_usd ?? Math.max(1, team.cost_usd)) * 1.5 * 100) / 100 });
    }
    if (q?.kind === 'approval' && q.command) {
      const ok = /승인|허용|yes|ok|진행/i.test(text) && !/거절|안\s*돼|no\b|취소/i.test(text);
      if (ok) this.L(teamId).approved.add(q.command);
      store.addDecision(teamId, 'user', ok ? 'approve' : 'reject', `${ok ? '명령 승인' : '명령 거절'}: ${truncate(q.command, 200)}`);
      text = ok ? `승인됨. 이 명령을 그대로(한 글자도 바꾸지 말고) 한 번 실행해라: ${q.command}` : `거절됨: ${text}. 그 명령은 실행하지 말고 다른 방법을 찾거나 report 해라.`;
    }
    if (q?.kind === 'tools' && q.tools?.length) {
      const ok = /승인|허용|yes|ok|진행/i.test(text) && !/거절|안\s*돼|no\b|취소/i.test(text);
      const tools = expandGrant(q.tools);
      if (ok) store.setKv(`grant:${teamId}`, [...new Set([...this.grants(teamId), ...tools])]);
      store.addDecision(teamId, 'user', ok ? 'grant' : 'reject', `${ok ? '임시 권한 승인' : '임시 권한 거절'}: ${q.tools.join(', ')}`);
      text = ok ? `승인됨. 임시 권한(${q.tools.join(', ')})을 받았다. 이제 그 도구로 하던 일을 이어서 해라.` : `거절됨: ${text}. 그 도구 없이 할 수 있는 방법을 찾거나 report 해라.`;
    }
    if (text === '여기서 마무리') { store.updateTeam(teamId, { question: null }); this.finish(teamId, { status: 'done', summary: `사용자가 여기서 마무리를 선택했다.\n${store.summaries(teamId, 1)[0]?.body ?? ''}` }); return; }
    store.updateTeam(teamId, { question: null, state: 'running', nudges: 0, paused_reason: null, pause_kind: null });
    const said = forAgent(this.deps.cfg, text);
    if (team.lifetime === 'standing') { store.updateTeam(teamId, { state: 'idle' }); this.wake(teamId, `사용자 답변: ${said}`); return; }
    this.kick(teamId, `사용자 답변: ${said}`);
  }

  /** 사람이 팀 PM 에게 직접 지시. 돌고 있으면 다음 도구 호출 때 끼워 넣는다. */
  message(teamId: string, text: string, actor: 'user' | 'po' = 'user'): 'delivered' | 'queued' {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) throw new Error('팀이 없습니다');
    if (['done', 'failed', 'archived'].includes(team.state)) throw new ConflictError('끝난 팀에는 지시할 수 없습니다. 다시 시작하거나 새 업무로 맡기세요.');
    const who = actor === 'user' ? '사용자' : '총괄';
    const fromLabel = actor === 'user' ? '사용자' : 'PO'; // 기록값은 예전 그대로('PO') — 화면이 「총괄」로 보여 준다
    const l = this.L(teamId);
    // 사람에게 온 질문(예산 포함)이 걸려 있으면 사람의 말은 그 질문의 답이다(답으로 한 번만 남긴다)
    if (!l.loop && team.question && actor === 'user' && ['waiting_human', 'idle', 'down', 'paused'].includes(team.state)) { this.answer(teamId, text); return 'delivered'; }
    store.addMessage({ team_id: teamId, from_label: fromLabel, to_label: 'PM', kind: 'instruction', body: text });
    text = forAgent(this.deps.cfg, text);
    if (l.loop) { l.pending.push(`${who} 직접 지시: ${text}`); return 'delivered'; }
    if (team.lifetime === 'standing') { this.wake(teamId, `${who} 지시: ${text}`); return team.state === 'paused' ? 'queued' : 'delivered'; }
    l.pending.push(`${who} 직접 지시: ${text}`);
    store.addChecklistItem(teamId, `(${who} 지시) ${truncate(text, 200)}`);
    return 'queued';
  }

  /** 직속 팀 깨우기(사용자 지시·점검 이상). */
  wake(teamId: string, prompt: string): void {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team || team.lifetime !== 'standing' || team.state === 'archived') return;
    const l = this.L(teamId);
    if (this.isRunning(teamId) || team.state === 'paused') { l.pending.push(prompt); return; }
    if (team.state === 'down') l.errors = 0;
    store.updateTeam(teamId, { state: 'running', started_at: team.started_at ?? nowIso(), question: null });
    l.starting = true;
    void this.ensureWorkspace(teamId).then(() => {
      l.starting = false;
      const t = store.getTeam(teamId);
      if (!t || t.state !== 'running') { if (t?.state === 'paused') l.pending.push(prompt); return; }
      this.kick(teamId, prompt);
    }).catch((e) => {
      l.starting = false;
      store.updateTeam(teamId, { state: 'down', error: String(e) });
      this.deps.notifier.send({ title: '직속 팀 시작 실패', body: `${team.name}: ${e}`, level: 'crit' });
    });
  }

  /** 직속 팀 되살리기: 세션 이어가기 실패가 반복되면 새 세션. */
  private async revive(teamId: string, err: string): Promise<boolean> {
    const { store, notifier } = this.deps;
    const team = store.getTeam(teamId)!;
    const l = this.L(teamId);
    store.updateTeam(teamId, { state: 'down', error: truncate(err, 500) });
    notifier.send({ title: '직속 팀 장애', body: `${team.name}: ${truncate(err, 200)} · 되살리는 중`, level: 'crit', url: `/#team-${teamId}` });
    store.addPoEvent('standing_down', teamId, { error: err });
    store.updateTeam(teamId, { state: 'reviving' });
    if (l.errors > 3) {
      store.updateTeam(teamId, { state: 'down' });
      notifier.send({ title: '직속 팀 복구 실패', body: `${team.name}: 3번 연속 실패. 확인이 필요합니다.`, level: 'crit', url: `/#team-${teamId}` });
      return false;
    }
    if (l.errors >= 2) {
      const pm = store.agentByRole(teamId, 'pm')!;
      store.updateAgent(pm.id, { session_id: null });
      store.addDecision(teamId, 'engine', 'revive', '이어가기 실패 반복 → 새 세션(지시서 + 최근 요약)');
    } else store.addDecision(teamId, 'engine', 'revive', '세션 이어가기로 재시도');
    store.updateTeam(teamId, { state: 'running', revived_count: team.revived_count + 1, last_heartbeat_at: nowIso() });
    notifier.send({ title: '직속 팀 복구', body: `${team.name} 다시 가동`, level: 'good', url: `/#team-${teamId}` });
    return true;
  }

  setPriority(teamId: string, p: Priority, actor: 'user' | 'agent' = 'user'): void {
    const { store } = this.deps;
    const t = store.updateTeam(teamId, { priority: p });
    if (t?.task_id) store.updateTask(t.task_id, { priority: p });
    store.addDecision(teamId, actor, 'priority', `우선순위 ${p}`);
  }
  pin(teamId: string, on: boolean, actor: 'user' | 'agent' = 'user'): void {
    this.deps.store.updateTeam(teamId, { pinned: on ? 1 : 0 });
    this.deps.store.addDecision(teamId, actor, 'pin', on ? '멈추지 않음' : '멈추지 않음 해제');
  }

  /** 직속 팀 종료: 사용자가 직접 또는 총괄에게 시켰을 때만 호출된다. */
  async endStanding(teamId: string, actor: 'user' | 'agent', reason: string): Promise<void> {
    const t = this.deps.store.getTeam(teamId);
    if (!t || t.lifetime !== 'standing') throw new ConflictError('직속 팀이 아닙니다');
    if (t.state === 'archived') return;
    await this.cancel(teamId);
    this.deps.store.addDecision(teamId, actor, 'end', `직속 팀 종료: ${truncate(reason, 200)}`);
  }

  /** 진행 중인 턴만 멈추고 쌓인 지시를 버린다(팀은 유지). 돌고 있지 않으면 false. */
  async cancelTurn(teamId: string): Promise<boolean> {
    const l = this.live.get(teamId);
    if (!l?.loop) return false;
    l.cancelled = true;
    l.pending = [];
    this.deps.slots.cancelTeam(teamId);
    if (l.hardPaused) await this.continueTree(teamId, '취소를 위해 강한 멈춤 해제');
    this.deps.store.addDecision(teamId, 'user', 'cancel_turn', '진행 중인 지시 취소');
    await Promise.all([l.handle?.interrupt(), ...[...l.subHandles].map((h) => h.interrupt())]);
    return true;
  }

  async cancel(teamId: string): Promise<void> {
    const { store } = this.deps;
    const l = this.live.get(teamId);
    this.deps.slots.cancelTeam(teamId);
    if (l?.hardPaused) await this.continueTree(teamId, '중단을 위해 강한 멈춤 해제');
    if (l?.loop) { l.pausePending = true; await Promise.all([l.handle?.interrupt(), ...[...l.subHandles].map((h) => h.interrupt())]); await l.loop; }
    const t = store.getTeam(teamId);
    if (!t) return;
    if (t.lifetime === 'standing') { store.updateTeam(teamId, { state: 'archived', finished_at: nowIso() }); return; }
    store.updateTeam(teamId, { state: 'failed', finished_at: nowIso(), error: '사용자가 중단', paused_reason: null, question: null });
    if (t.task_id) store.updateTask(t.task_id, { status: 'failed', finished_at: nowIso() });
    store.addDecision(teamId, 'user', 'cancel', '사용자가 중단');
  }

  /** worktree 정리(브랜치는 남긴다) 후 보관. */
  async archive(teamId: string, by = '사용자', o: { discarded?: boolean } = {}): Promise<void> {
    const { store, cfg } = this.deps;
    const t = store.getTeam(teamId);
    if (!t) return;
    if (this.isRunning(teamId)) throw new Error('돌고 있는 팀은 정리할 수 없습니다. 먼저 중단하세요.');
    const p = store.getProject(t.project_id);
    let patch: { path: string; files: number } | null = null;
    if (p && t.worktree_path) {
      // 지우기 전에 변경을 패치로 남긴다(지운 뒤에도 팀 상세·총괄이 볼 수 있게)
      patch = await saveWorktreePatch(cfg, t.worktree_path, t.base_sha, t.id).catch((e) => { log.warn(`패치 저장 실패 ${teamId}`, e); return null; });
      await removeWorktree(p.path, t.worktree_path);
      store.addCleanupLog({ project_id: t.project_id, team_id: teamId, kind: 'worktree', target: t.worktree_path, branch: t.branch, by, discarded: !!o.discarded, patch_path: patch?.path ?? null, patch_files: patch?.files ?? 0, note: patch ? `변경 ${patch.files}개 파일을 패치로 보관` : '변경 없음' });
    }
    store.updateTeam(teamId, { state: 'archived', worktree_path: null });
    store.addDecision(teamId, 'user', 'archive', `worktree 정리(${by}) · 브랜치 ${t.branch ?? '-'} 는 남김${patch ? ` · 변경 ${patch.files}개 파일 패치 보관` : ''}`);
  }

  /** 서버 시작 시: 돌던 팀은 이어가기 대기열로, 직속 팀은 이어서 깨운다. */
  recover(): void {
    const { store } = this.deps;
    for (const t of store.listTeams("state IN ('running','reviving','down')")) {
      if (t.lifetime === 'standing') { store.updateTeam(t.id, { state: 'idle' }); this.wake(t.id, '서버가 다시 시작되었다. 끊기기 전 하던 일이 있으면 이어서 진행하고, 없으면 짧게 대기 상태라고 답해라.'); }
      else store.updateTeam(t.id, { state: 'queued' });
      store.addDecision(t.id, 'engine', 'recover', '서버 재시작 후 이어가기');
    }
    for (const t of store.listTeams("state = 'paused' AND pause_kind = 'engine-hard'")) store.updateTeam(t.id, { pause_kind: 'engine-soft' });
    store.db.prepare("UPDATE agents SET state = 'idle', current_step = '대기' WHERE state = 'busy'").run();
    store.db.prepare("UPDATE runs SET status = 'error', ended_at = ? WHERE status = 'running'").run(nowIso());
  }
}

function normalizeRoles(roles: TemplateRole[]): TemplateRole[] {
  const out = roles.map((r) => ({ ...r, mode: r.key === 'pm' ? 'session' as const : r.mode, tools: r.key === 'pm' ? 'pm' as const : r.tools }));
  if (!out.some((r) => r.key === 'pm')) out.unshift({ key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm' });
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}
