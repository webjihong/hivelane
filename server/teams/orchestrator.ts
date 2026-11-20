import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from '../config.ts';
import { bus } from '../bus.ts';
import { logger } from '../log.ts';
import type { Notifier } from '../notify/index.ts';
import { addWorktree, collectChanges, prepareDeps, removeWorktree, slug } from '../projects/git.ts';
import type { AgentRow, Store, TeamRow } from '../store.ts';
import { nowIso, parseJson, truncate } from '../util.ts';
import { pmPrompt, rolePrompt } from '../agents/prompts.ts';
import { presetTools, TurnHandle, type TurnResult, type TurnSpec } from '../agents/runner.ts';
import type { HeavySlots } from '../po/slots.ts';
import { teamMcpServer, teamToolNames, type TeamTools } from './tools.ts';
import type { Priority, Project, TemplateRole } from '../../shared/types.ts';

const log = logger('team');

export interface TurnRunner { runTurn(spec: TurnSpec, handle: TurnHandle): Promise<TurnResult> }

interface Live {
  handle: TurnHandle | null;
  subHandles: Set<TurnHandle>;
  loop: Promise<void> | null;
  pending: string[];
  reported: { status: 'done' | 'failed'; summary: string } | null;
  asked: { question: string; options: string[] } | null;
  pausePending: boolean;
  hardPaused: boolean;
  errors: number;
  overlapsSent: Set<string>;
}

const MAX_NUDGES = 3;
const MAX_ERROR_RETRY = 2;

export class Orchestrator {
  private live = new Map<string, Live>();
  constructor(private deps: { cfg: AppConfig; store: Store; runner: TurnRunner; slots: HeavySlots; notifier: Notifier }) {}

  private L(teamId: string): Live {
    let l = this.live.get(teamId);
    if (!l) { l = { handle: null, subHandles: new Set(), loop: null, pending: [], reported: null, asked: null, pausePending: false, hardPaused: false, errors: 0, overlapsSent: new Set() }; this.live.set(teamId, l); }
    return l;
  }
  isRunning(teamId: string): boolean { return !!this.live.get(teamId)?.loop; }
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
    const roles = normalizeRoles(input.roles ?? store.getTemplate(input.template_id)?.roles ?? store.getTemplate('tpl-ops')!.roles);
    const team = store.insertTeam({
      name: input.name, project_id: input.project_id, managed_by: 'user', lifetime: 'standing', standing_brief: input.brief, state: 'idle', priority: 'urgent',
      check_command: input.check_command || null, check_interval_sec: input.check_interval_sec || null, readable_team_ids: JSON.stringify(input.readable_team_ids ?? []),
    });
    this.createAgents(team, roles, store.getProject(input.project_id), true, input.brief);
    store.updateTeam(team.id, { last_heartbeat_at: nowIso() });
    store.addDecision(team.id, 'user', 'create', '직속 팀 생성');
    return store.getTeam(team.id)!;
  }

  updateStanding(teamId: string, patch: { name?: string; brief?: string; check_command?: string | null; check_interval_sec?: number | null; readable_team_ids?: string[] }): void {
    const { store } = this.deps;
    const t = store.getTeam(teamId);
    if (!t || t.lifetime !== 'standing') throw new Error('직속 팀이 아닙니다');
    store.updateTeam(teamId, {
      ...(patch.name ? { name: patch.name } : {}), ...(patch.brief !== undefined ? { standing_brief: patch.brief } : {}),
      ...(patch.check_command !== undefined ? { check_command: patch.check_command || null } : {}),
      ...(patch.check_interval_sec !== undefined ? { check_interval_sec: patch.check_interval_sec || null } : {}),
      ...(patch.readable_team_ids ? { readable_team_ids: JSON.stringify(patch.readable_team_ids) } : {}),
    });
    if (patch.brief !== undefined) {
      const pm = store.agentByRole(teamId, 'pm');
      const roles = this.rolesOf(teamId);
      if (pm) store.updateAgent(pm.id, { system_prompt: pmPrompt({ roles, project: store.getProject(t.project_id), standing: true, standingBrief: patch.brief }) });
    }
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
    try {
      await this.ensureWorkspace(teamId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.updateTeam(teamId, { state: 'failed', error: `작업 공간 준비 실패: ${msg}`, finished_at: nowIso() });
      store.addDecision(teamId, 'engine', 'fail', `작업 공간 준비 실패: ${msg}`);
      this.deps.notifier.send({ title: '팀 시작 실패', body: `${team.name}: ${msg}`, level: 'crit', url: `/#team-${teamId}` });
      return;
    }
    const fresh = store.getTeam(teamId)!;
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
    l.loop = this.loop(teamId, prompt).catch((e) => log.error(`루프 예외 ${teamId}`, e)).finally(() => { l.loop = null; l.handle = null; bus.changed('team'); });
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
        const q = { text: l.asked.question, options: l.asked.options, asked_at: nowIso() };
        store.updateTeam(teamId, { state: after.lifetime === 'standing' ? 'idle' : 'waiting_human', question: JSON.stringify(q) });
        store.addMessage({ team_id: teamId, from_label: 'PM', to_label: '사용자', kind: 'question', body: l.asked.question + (l.asked.options.length ? `\n선택지: ${l.asked.options.join(' / ')}` : '') });
        store.addPoEvent('ask_human', teamId, { question: l.asked.question });
        this.deps.notifier.send({ title: '사람 확인 필요', body: `${after.name}: ${l.asked.question}`, level: 'crit', url: `/#team-${teamId}`, tag: `ask-${teamId}` });
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
        if (res.text.trim()) store.addMessage({ team_id: teamId, from_label: 'PM', to_label: '사용자', kind: 'report', body: res.text.trim() });
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

  private pmSpec(team: TeamRow, pm: AgentRow, prompt: string, resume: string | null): TurnSpec {
    const { store, cfg } = this.deps;
    const project = store.getProject(team.project_id);
    const roles = this.rolesOf(team.id);
    const sessionRoles = roles.filter((r) => r.key !== 'pm' && r.mode === 'session');
    const readable = parseJson<string[]>(team.readable_team_ids, []).length > 0;
    const impl = this.toolsFor(team.id);
    const subagents: TurnSpec['subagents'] = {};
    for (const r of roles.filter((r) => r.key !== 'pm' && r.mode === 'subagent')) {
      const a = store.agentByRole(team.id, r.key)!;
      subagents[r.key] = { description: `${r.name} 담당`, prompt: a.system_prompt, model: r.model, tools: presetTools(r.tools), roleAgentId: a.id, roleName: r.name } as AgentDefinition & { roleAgentId: string; roleName: string };
    }
    const wt = team.worktree_path ?? cfg.home;
    const l = this.L(team.id);
    return {
      agent: pm, team, prompt, cwd: wt, systemAppend: pm.system_prompt,
      allowedTools: [...presetTools('pm'), ...teamToolNames(sessionRoles.length > 0, readable)],
      additionalDirectories: project?.memory_paths ?? [],
      writableRoots: [wt],
      heavyPatterns: project?.heavy_patterns ?? [],
      blockedPatterns: project?.blocked_patterns ?? [],
      mcpServers: { hivelane: teamMcpServer(impl, { sessionRoles: sessionRoles.map((r) => ({ key: r.key, name: r.name })), readableTeams: readable }) },
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
      const res = await this.deps.runner.runTurn({
        agent, team, prompt: instruction, cwd: wt, systemAppend: agent.system_prompt, allowedTools: presetTools(role.tools),
        additionalDirectories: project?.memory_paths ?? [], writableRoots: [wt], heavyPatterns: project?.heavy_patterns ?? [], blockedPatterns: project?.blocked_patterns ?? [],
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

  private finish(teamId: string, r: { status: 'done' | 'failed'; summary: string }): void {
    const { store } = this.deps;
    const team = store.getTeam(teamId)!;
    store.addSummary({ team_id: teamId, stage: '최종', body: r.summary });
    store.addMessage({ team_id: teamId, from_label: 'PM', to_label: 'PO', kind: 'report', body: r.summary });
    if (team.lifetime === 'standing') { store.updateTeam(teamId, { state: 'idle' }); return; }
    store.updateTeam(teamId, { state: r.status, stage: r.status === 'done' ? 4 : team.stage, finished_at: nowIso(), question: null });
    store.updateTask(team.task_id!, { status: r.status, finished_at: nowIso() });
    store.addDecision(teamId, 'agent', r.status, r.status === 'done' ? '업무 완료 보고' : '실패 보고');
    store.addPoEvent('report', teamId, { status: r.status });
    this.deps.notifier.send({ title: r.status === 'done' ? '업무 완료' : '업무 실패', body: `${team.name}\n${truncate(r.summary, 300)}`, level: r.status === 'done' ? 'good' : 'crit', url: `/#team-${teamId}` });
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
    store.addDecision(teamId, kind === 'user' ? 'user' : 'engine', 'pause', reason);
    store.updateTeam(teamId, { paused_reason: reason, pause_kind: kind });
    const l = this.live.get(teamId);
    if (l?.loop) {
      l.pausePending = true;
      this.deps.slots.cancelTeam(teamId);
      await Promise.all([l.handle?.interrupt(), ...[...l.subHandles].map((h) => h.interrupt())]);
    } else if (team.state === 'queued' || team.state === 'waiting_human' || team.state === 'running') {
      store.updateTeam(teamId, { state: 'paused' });
    }
    if (kind !== 'user') this.deps.notifier.send({ title: '팀 일시정지', body: `${team.name}: ${reason}`, level: 'warn', url: `/#team-${teamId}`, tag: `pause-${teamId}` });
    store.addPoEvent('paused', teamId, { by: kind, reason });
  }

  /** 강한 멈춤: 프로세스 트리 SIGSTOP. 엔진이 pids 를 넘긴다. */
  markHardPaused(teamId: string, on: boolean, reason: string): void {
    const l = this.L(teamId);
    l.hardPaused = on;
    this.deps.store.updateTeam(teamId, { pause_kind: on ? 'engine-hard' : 'engine-soft' });
    this.deps.store.addDecision(teamId, 'engine', on ? 'hard-pause' : 'hard-resume', reason);
  }

  async resume(teamId: string, by: 'engine' | 'user', reason = ''): Promise<void> {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) return;
    const l = this.L(teamId);
    store.addDecision(teamId, by, 'resume', reason || '재개');
    store.updateTeam(teamId, { paused_reason: null, pause_kind: null });
    if (l.loop) { l.pausePending = false; if (l.handle) l.handle.pauseRequested = false; return; }
    if (team.state !== 'paused') return;
    const pm = store.agentByRole(teamId, 'pm');
    if (!team.started_at || !pm?.session_id) { store.updateTeam(teamId, { state: 'queued' }); return; }
    store.updateTeam(teamId, { state: 'running' });
    this.kick(teamId, '일시정지가 풀렸다. 할 일 목록을 확인하고 이어서 진행해라.');
  }

  answer(teamId: string, text: string): void {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) throw new Error('팀이 없습니다');
    const q = parseJson<{ kind?: string } | null>(team.question, null);
    store.addMessage({ team_id: teamId, from_label: '사용자', to_label: 'PM', kind: 'reply', body: text });
    store.addDecision(teamId, 'user', 'answer', truncate(text, 200));
    if (q?.kind === 'budget') {
      if (text.includes('마무리')) { store.updateTeam(teamId, { question: null }); this.finish(teamId, { status: 'failed', summary: `예산 상한에서 사용자가 마무리를 선택했다. 지금까지 사용 $${team.cost_usd.toFixed(2)}` }); return; }
      store.updateTeam(teamId, { budget_usd: Math.round((team.budget_usd ?? store.getSettings().defaultBudgetUsd) * 1.5 * 100) / 100 });
    }
    if (text === '여기서 마무리') { store.updateTeam(teamId, { question: null }); this.finish(teamId, { status: 'done', summary: `사용자가 여기서 마무리를 선택했다.\n${store.summaries(teamId, 1)[0]?.body ?? ''}` }); return; }
    store.updateTeam(teamId, { question: null, state: team.lifetime === 'standing' ? 'running' : 'running', nudges: 0 });
    this.kick(teamId, `사용자 답변: ${text}`);
  }

  /** 사람이 팀 PM 에게 직접 지시. 돌고 있으면 다음 도구 호출 때 끼워 넣는다. */
  message(teamId: string, text: string): 'delivered' | 'queued' {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) throw new Error('팀이 없습니다');
    store.addMessage({ team_id: teamId, from_label: '사용자', to_label: 'PM', kind: 'instruction', body: text });
    const l = this.L(teamId);
    if (l.loop) { l.pending.push(text); return 'delivered'; }
    if (team.lifetime === 'standing') { this.wake(teamId, `사용자 지시: ${text}`); return 'delivered'; }
    if (team.state === 'waiting_human') { this.answer(teamId, text); return 'delivered'; }
    l.pending.push(`사용자 직접 지시: ${text}`);
    store.addChecklistItem(teamId, `(사용자 지시) ${truncate(text, 200)}`);
    return 'queued';
  }

  /** 직속 팀 깨우기(사용자 지시·점검 이상). */
  wake(teamId: string, prompt: string): void {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team || team.lifetime !== 'standing') return;
    if (this.isRunning(teamId)) { this.L(teamId).pending.push(prompt); return; }
    store.updateTeam(teamId, { state: 'running', started_at: team.started_at ?? nowIso(), question: null });
    void this.ensureWorkspace(teamId).then(() => this.kick(teamId, prompt)).catch((e) => {
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

  async cancel(teamId: string): Promise<void> {
    const { store } = this.deps;
    const l = this.live.get(teamId);
    if (l?.loop) { l.pausePending = true; await Promise.all([l.handle?.interrupt(), ...[...l.subHandles].map((h) => h.interrupt())]); await l.loop; }
    const t = store.getTeam(teamId);
    if (!t) return;
    if (t.lifetime === 'standing') { store.updateTeam(teamId, { state: 'archived', finished_at: nowIso() }); return; }
    store.updateTeam(teamId, { state: 'failed', finished_at: nowIso(), error: '사용자가 중단', paused_reason: null, question: null });
    if (t.task_id) store.updateTask(t.task_id, { status: 'failed', finished_at: nowIso() });
    store.addDecision(teamId, 'user', 'cancel', '사용자가 중단');
  }

  /** worktree 정리(브랜치는 남긴다) 후 보관. */
  async archive(teamId: string): Promise<void> {
    const { store } = this.deps;
    const t = store.getTeam(teamId);
    if (!t) return;
    if (this.isRunning(teamId)) throw new Error('돌고 있는 팀은 정리할 수 없습니다. 먼저 중단하세요.');
    const p = store.getProject(t.project_id);
    if (p && t.worktree_path) await removeWorktree(p.path, t.worktree_path);
    store.updateTeam(teamId, { state: 'archived', worktree_path: null });
    store.addDecision(teamId, 'user', 'archive', `worktree 정리 · 브랜치 ${t.branch ?? '-'} 는 남김`);
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
  }
}

function normalizeRoles(roles: TemplateRole[]): TemplateRole[] {
  const out = roles.map((r) => ({ ...r, mode: r.key === 'pm' ? 'session' as const : r.mode, tools: r.key === 'pm' ? 'pm' as const : r.tools }));
  if (!out.some((r) => r.key === 'pm')) out.unshift({ key: 'pm', name: 'PM', model: 'opus', mode: 'session', tools: 'pm' });
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}
