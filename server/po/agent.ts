import { mkdirSync } from 'node:fs';
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { bus } from '../bus.ts';
import type { AppConfig } from '../config.ts';
import { logger } from '../log.ts';
import type { Notifier } from '../notify/index.ts';
import type { Search } from '../search/index.ts';
import type { Store, TeamRow } from '../store.ts';
import type { Orchestrator, TurnRunner } from '../teams/orchestrator.ts';
import { parseJson, truncate } from '../util.ts';
import { poPrompt } from '../agents/prompts.ts';
import { TurnHandle } from '../agents/runner.ts';
import type { Priority, TemplateRole } from '../../shared/types.ts';

/** 모델이 ToolSearch 없이 바로 쓰도록 항상 로드 */
const T: typeof tool = (n, d, s, h, x) => tool(n, d, s, h, { ...x, alwaysLoad: true });


const log = logger('po');
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

type Job = { kind: 'user'; text: string } | { kind: 'events' };

const EVENT_LABEL: Record<string, string> = {
  report: '팀 보고', ask_human: '사람 확인 필요', stall: '정체', paused: '일시정지', overlap: '파일 겹침', budget: '예산 상한', error: '팀 오류', standing_down: '직속 팀 장애',
};

export interface PoTools {
  listProjects(): string; listTemplates(): string; listTeams(state?: string): string; getTaskStatus(teamId?: string): string;
  findChanges(pathContains?: string, sinceHours?: number, project?: string): string; getTimeline(fromIso?: string, toIso?: string, project?: string): string;
  searchRecords(q: string, project?: string): Promise<string>;
  proposeTeam(p: { project: string | null; title: string; instruction: string; brief: string; template_id: string; roles?: TemplateRole[]; priority: Priority; budget_usd?: number | null; note?: string }): string;
  sendToTeam(teamId: string, msg: string): string; setPriority(teamId: string, p: Priority): string; pauseTeam(teamId: string, reason: string): Promise<string>; resumeTeam(teamId: string): Promise<string>; pinTeam(teamId: string, on: boolean): string;
}

export class PoAgent {
  private jobs: Job[] = [];
  private running = false;
  private eventTimer: NodeJS.Timeout | null = null;
  private handle: TurnHandle | null = null;
  busy = false;

  constructor(private deps: { cfg: AppConfig; store: Store; runner: TurnRunner; orch: Orchestrator; search: Search; notifier: Notifier }) {
    mkdirSync(deps.cfg.poDir, { recursive: true });
    bus.on('po_event', () => this.scheduleEvents());
    // 서버가 꺼져 있던 동안 쌓인 사건도 처리
    if (deps.store.pendingPoEvents().length) this.scheduleEvents();
  }

  /** 사용자 → PO */
  say(textIn: string): void {
    this.deps.store.addChat({ role: 'user', body: textIn });
    this.jobs.push({ kind: 'user', text: textIn });
    void this.pump();
  }

  private scheduleEvents(): void {
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => { this.eventTimer = null; if (!this.jobs.some((j) => j.kind === 'events')) this.jobs.push({ kind: 'events' }); void this.pump(); }, 3000);
  }

  private agentRow() {
    const { store } = this.deps;
    const s = store.getSettings();
    let a = store.poAgent();
    if (!a) a = store.insertAgent({ team_id: null, role_key: 'po', role_name: 'PO', model: s.poModel, run_mode: 'session', system_prompt: '', allowed_tools: [] });
    if (a.model !== s.poModel) { store.updateAgent(a.id, { model: s.poModel }); a = store.poAgent()!; }
    return a;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        // 연속된 사용자 메시지·사건은 한 턴에 묶는다
        const batch = this.jobs.splice(0);
        const userTexts = batch.filter((j): j is { kind: 'user'; text: string } => j.kind === 'user').map((j) => j.text);
        const events = batch.some((j) => j.kind === 'events') ? this.deps.store.pendingPoEvents() : [];
        if (!userTexts.length && !events.length) continue;
        await this.turn(userTexts, events);
      }
    } finally { this.running = false; }
  }

  private async turn(userTexts: string[], events: ReturnType<Store['pendingPoEvents']>): Promise<void> {
    const { store, cfg } = this.deps;
    const agent = this.agentRow();
    const projects = store.listProjects();
    const parts: string[] = [];
    if (events.length) {
      parts.push(events.map((e) => {
        const t = store.getTeam(e.team_id);
        const p = parseJson<Record<string, unknown>>(e.payload, {});
        return `[사건] ${EVENT_LABEL[e.type] ?? e.type} · 팀 ${t?.name ?? '-'} (${e.team_id ?? '-'}) · ${truncate(JSON.stringify(p), 400)}`;
      }).join('\n'));
    }
    if (userTexts.length) parts.push(`사용자: ${userTexts.join('\n사용자: ')}`);
    const prompt = parts.join('\n\n');
    const prompted = poPrompt(projects);
    if (agent.system_prompt !== prompted) store.updateAgent(agent.id, { system_prompt: prompted });
    const impl = this.tools();
    this.busy = true;
    bus.changed('po');
    const handle = new TurnHandle();
    this.handle = handle;
    try {
      const resume = agent.session_id;
      const res = await this.deps.runner.runTurn({
        agent: store.poAgent()!, team: null, prompt: resume ? prompt : this.bootstrap() + prompt, cwd: cfg.poDir, systemAppend: prompted,
        allowedTools: ['Read', 'Glob', 'Grep', ...PO_TOOL_NAMES], additionalDirectories: projects.map((p) => p.path), writableRoots: [cfg.poDir],
        mcpServers: { hivelane: poMcpServer(impl) }, toolsImpl: impl, settingSources: [], resume, label: 'PO', priority: 'urgent', standing: true,
      }, handle);
      store.markPoEventsHandled(events.map((e) => e.id));
      if (res.contextTokens > store.getSettings().contextLimitTokens) {
        store.updateAgent(agent.id, { session_id: null });
        log.info(`PO 맥락 ${Math.round(res.contextTokens / 1000)}k → 다음 턴 새 세션`);
      }
      const say = res.text.trim();
      if (!res.ok) store.addChat({ role: 'event', body: `PO 응답 실패: ${res.error ?? res.subtype}`, tone: 'warn' });
      else if (say && say !== '-') store.addChat({ role: 'po', body: say });
      if (!res.ok && agent.session_id && /session|resume/i.test(res.error ?? '')) store.updateAgent(agent.id, { session_id: null });
    } catch (e) {
      log.error('PO 턴 실패', e);
      store.addChat({ role: 'event', body: `PO 오류: ${e instanceof Error ? e.message : e}`, tone: 'warn' });
    } finally {
      this.busy = false;
      this.handle = null;
      bus.changed('po');
    }
  }

  async stop(): Promise<void> { await this.handle?.interrupt(); }

  /** 새 세션 시작 때 DB 에서 읽어 주는 현황 요약. */
  private bootstrap(): string {
    const { store } = this.deps;
    const active = store.listTeams("state IN ('queued','running','paused','waiting_human','idle','down','reviving')");
    const recent = store.listTeams("state IN ('done','failed')").slice(0, 10);
    const chat = store.chat(12).map((c) => `${c.role}: ${truncate(c.body, 200)}`).join('\n');
    return `## 현재 현황 (DB에서 읽음, 새 세션)
진행 중 팀:
${active.map((t) => `- ${t.id} ${t.name} · ${t.state} · ${t.lifetime === 'standing' ? '직속' : 'PO'} · 우선순위 ${t.priority}`).join('\n') || '- 없음'}
최근 끝난 팀:
${recent.map((t) => `- ${t.id} ${t.name} · ${t.state} · ${t.finished_at ?? ''}`).join('\n') || '- 없음'}
최근 대화:
${chat}

`;
  }

  tools(): PoTools {
    const { store, orch, search } = this.deps;
    const teamLine = (t: TeamRow) => `- ${t.id} 「${t.name}」 ${t.state}${t.paused_reason ? `(${t.paused_reason})` : ''} · ${t.lifetime === 'standing' ? '직속' : 'PO'} · ${store.getProject(t.project_id)?.name ?? '-'} · 우선순위 ${t.priority}${t.pinned ? '·고정' : ''} · 단계 ${['기획', '구현', '검사', '보고', '끝'][t.stage]} · $${t.cost_usd.toFixed(2)}`;
    const projectId = (name?: string | null) => (name ? store.findProjectByName(name)?.id ?? name : null);
    return {
      listProjects: () => store.listProjects().map((p) => `- ${p.id} ${p.name} · ${p.path} · 기준 ${p.base_ref} · 의존성 ${p.deps_strategy}`).join('\n') || '등록된 프로젝트가 없다.',
      listTemplates: () => store.listTemplates().map((t) => `- ${t.id} ${t.name}: ${t.description} · ${t.roles.map((r) => `${r.key}(${r.name}/${r.model}/${r.mode})`).join(', ')}`).join('\n'),
      listTeams: (state) => store.listTeams(state ? `state = '${state.replace(/'/g, '')}'` : "state != 'archived'").slice(0, 60).map(teamLine).join('\n') || '팀이 없다.',
      getTaskStatus: (teamId) => {
        if (!teamId) return store.listTeams("state IN ('queued','running','paused','waiting_human','idle','down','reviving')").map(teamLine).join('\n') || '진행 중 팀이 없다.';
        const d = store.teamDetail(teamId);
        if (!d) return '없는 팀이다.';
        return `${teamLine(store.getTeam(teamId)!)}\n브랜치 ${d.team.branch ?? '-'}\n할 일:\n${d.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n') || '(없음)'}\n질문: ${d.team.question?.text ?? '-'}\n최근 요약:\n${d.summaries.slice(0, 4).map((s) => `[${s.stage}] ${truncate(s.body, 500)}`).join('\n')}\n바뀐 파일: ${d.files.map((f) => f.path).join(', ') || '-'}`;
      },
      findChanges: (pathContains, sinceHours, project) => {
        const pid = projectId(project);
        const rows = store.db.prepare(`SELECT f.path, f.change_type, f.lines_added, f.lines_removed, f.created_at, t.id team_id, t.name, t.state FROM file_changes f JOIN teams t ON t.id = f.team_id
          WHERE (? IS NULL OR f.path LIKE ?) AND (? IS NULL OR f.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)) AND (? IS NULL OR f.project_id = ?) ORDER BY f.created_at DESC LIMIT 80`)
          .all(pathContains ?? null, `%${pathContains ?? ''}%`, sinceHours ?? null, `-${sinceHours ?? 0} hours`, pid, pid) as { path: string; change_type: string; lines_added: number; lines_removed: number; created_at: string; team_id: string; name: string; state: string }[];
        return rows.map((r) => `- ${r.path} (${r.change_type} +${r.lines_added} -${r.lines_removed}) · 팀 ${r.team_id} 「${r.name}」 ${r.state} · ${r.created_at}`).join('\n') || '해당 변경이 없다.';
      },
      getTimeline: (fromIso, toIso, project) => {
        const pid = projectId(project);
        const rows = store.db.prepare(`SELECT s.created_at, s.stage, s.body, t.name, t.id FROM work_summaries s LEFT JOIN teams t ON t.id = s.team_id
          WHERE s.created_at >= coalesce(?, '0000') AND s.created_at <= coalesce(?, '9999') AND (? IS NULL OR s.project_id = ?) ORDER BY s.created_at DESC LIMIT 60`)
          .all(fromIso ?? null, toIso ?? null, pid, pid) as { created_at: string; stage: string; body: string; name: string | null; id: string | null }[];
        return rows.map((r) => `- ${r.created_at} 「${r.name ?? '-'}」(${r.id ?? '-'}) [${r.stage}] ${truncate(r.body, 300)}`).join('\n') || '해당 기간 기록이 없다.';
      },
      searchRecords: async (q, project) => {
        const hits = await search.search(q, { projectId: projectId(project), limit: 15 });
        return hits.map((h) => `- [${h.source_type}/${h.via}] 팀 ${h.team_id ?? '-'} · ${h.created_at}: ${truncate(h.text, 300)}`).join('\n') || '검색 결과가 없다.';
      },
      proposeTeam: (p) => {
        const s = store.getSettings();
        const tpl = store.getTemplate(p.template_id) ?? store.listTemplates()[0]!;
        const pid = projectId(p.project) ?? (store.listProjects().length === 1 ? store.listProjects()[0]!.id : null);
        const prop = store.insertProposal({ project_id: pid, title: p.title, instruction: p.instruction, brief: p.brief, template_id: tpl.id, roles: p.roles?.length ? p.roles : tpl.roles, priority: p.priority, budget_usd: p.budget_usd ?? s.defaultBudgetUsd, note: p.note ?? '' });
        store.addChat({ role: 'po', body: p.note?.trim() || `「${p.title}」 팀 구성을 제안합니다.`, proposal_id: prop.id });
        if (s.autoApprove) {
          const team = orch.createFromProposal(prop.id);
          store.addChat({ role: 'event', body: `자동 승인 · 「${p.title}」 팀 생성`, team_id: team.id, tone: 'good' });
          return `제안 ${prop.id} 를 만들었고 자동 승인 설정이라 팀 ${team.id} 가 생성됐다.`;
        }
        return `제안 ${prop.id} 를 만들었다. 사용자가 화면에서 승인하면 팀이 생긴다.`;
      },
      sendToTeam: (teamId, msg) => { if (!store.getTeam(teamId)) return '없는 팀이다.'; const r = orch.message(teamId, `(PO 전달) ${msg}`); return r === 'delivered' ? '전달했다.' : '팀이 멈춰 있어 재개될 때 전달된다.'; },
      setPriority: (teamId, p) => { orch.setPriority(teamId, p, 'agent'); return `우선순위를 ${p}로 바꿨다.`; },
      pauseTeam: async (teamId, reason) => { await orch.pause(teamId, 'user', `PO: ${reason}`); return '멈췄다.'; },
      resumeTeam: async (teamId) => { await orch.resume(teamId, 'user', 'PO 재개'); return '재개했다.'; },
      pinTeam: (teamId, on) => { orch.pin(teamId, on, 'agent'); return on ? '멈추지 않음으로 설정했다.' : '해제했다.'; },
    };
  }
}

const PO_TOOL_NAMES = ['list_projects', 'list_templates', 'list_teams', 'get_task_status', 'find_changes', 'get_timeline', 'search_records', 'propose_team', 'send_to_team', 'set_priority', 'pause_team', 'resume_team', 'pin_team'].map((n) => `mcp__hivelane__${n}`);

const roleSchema = z.object({ key: z.string(), name: z.string(), model: z.enum(['opus', 'sonnet', 'haiku']), mode: z.enum(['session', 'subagent']), tools: z.enum(['pm', 'write', 'verify', 'read']), prompt: z.string().optional() });

function poMcpServer(impl: PoTools) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK 가 도구 배열을 any 스키마로 받는다
  const tools: SdkMcpToolDefinition<any>[] = [
    T('list_projects', '등록된 프로젝트 목록', {}, async () => text(impl.listProjects())),
    T('list_templates', '팀 템플릿 목록(역할·모델·실행 방식)', {}, async () => text(impl.listTemplates())),
    T('list_teams', '팀 목록. state 로 거를 수 있다', { state: z.string().optional() }, async (a) => text(impl.listTeams(a.state))),
    T('get_task_status', '팀 하나의 상세(할 일·질문·요약·바뀐 파일). team_id 없으면 진행 중 전체', { team_id: z.string().optional() }, async (a) => text(impl.getTaskStatus(a.team_id))),
    T('find_changes', '파일 변경 기록 조회', { path_contains: z.string().optional(), since_hours: z.number().optional(), project: z.string().optional() }, async (a) => text(impl.findChanges(a.path_contains, a.since_hours, a.project))),
    T('get_timeline', '기간별 작업 요약', { from: z.string().optional().describe('ISO 시각'), to: z.string().optional(), project: z.string().optional() }, async (a) => text(impl.getTimeline(a.from, a.to, a.project))),
    T('search_records', '대화·요약·파일 기록 전문/의미 검색', { query: z.string(), project: z.string().optional() }, async (a) => text(await impl.searchRecords(a.query, a.project))),
    T('propose_team', '팀 구성을 제안한다(사용자가 승인해야 생성)', {
      project: z.string().nullable().describe('프로젝트 id 또는 이름'), title: z.string(), instruction: z.string().describe('사용자 원문'), brief: z.string().describe('PM에게 줄 구체적 지시'),
      template_id: z.string(), roles: z.array(roleSchema).optional().describe('템플릿 역할을 바꿀 때만'), priority: z.enum(['urgent', 'normal', 'low']).default('normal'),
      budget_usd: z.number().optional(), note: z.string().optional().describe('사용자에게 보일 한두 문장'),
    }, async (a) => text(impl.proposeTeam({ ...a, project: a.project ?? null, roles: a.roles as TemplateRole[] | undefined }))),
    T('send_to_team', '팀 PM 에게 말을 전한다', { team_id: z.string(), message: z.string() }, async (a) => text(impl.sendToTeam(a.team_id, a.message))),
    T('set_priority', '팀 우선순위 변경', { team_id: z.string(), priority: z.enum(['urgent', 'normal', 'low']) }, async (a) => text(impl.setPriority(a.team_id, a.priority))),
    T('pause_team', '팀을 멈춘다(근거 필요)', { team_id: z.string(), reason: z.string() }, async (a) => text(await impl.pauseTeam(a.team_id, a.reason))),
    T('resume_team', '멈춘 팀을 재개', { team_id: z.string() }, async (a) => text(await impl.resumeTeam(a.team_id))),
    T('pin_team', '「멈추지 않음」 설정/해제', { team_id: z.string(), on: z.boolean() }, async (a) => text(impl.pinTeam(a.team_id, a.on))),
  ];
  return createSdkMcpServer({ name: 'hivelane', version: '0.1.0', tools });
}
