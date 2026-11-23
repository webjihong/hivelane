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
import { forAgent } from '../uploads.ts';
import { poPrompt } from '../agents/prompts.ts';
import { TurnHandle } from '../agents/runner.ts';
import type { Priority, TemplateRole } from '../../shared/types.ts';
import { cpus, loadavg } from 'node:os';
import { CpuMeter, cwdsOf, diagnose, listProcDetails, memPercent } from './resources.ts';
import { DEFAULT_BLOCKED, DEFAULT_HEAVY } from '../store.ts';

/** 모델이 ToolSearch 없이 바로 쓰도록 항상 로드 */
const T: typeof tool = (n, d, s, h, x) => tool(n, d, s, h, { ...x, alwaysLoad: true });


const log = logger('po');
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

type Job = { kind: 'user'; text: string } | { kind: 'events' };

const EVENT_LABEL: Record<string, string> = {
  team_reply: '팀 답변(PO가 맡긴 일)', report: '팀 보고', ask_human: '사람 확인 필요', stall: '정체', paused: '일시정지', overlap: '파일 겹침', budget: '예산 상한', error: '팀 오류', standing_down: '직속 팀 장애',
};

export interface PoTools {
  listProjects(): string; listTemplates(): string; listTeams(state?: string): string; getTaskStatus(teamId?: string): string;
  findChanges(pathContains?: string, sinceHours?: number, project?: string): string; getTimeline(fromIso?: string, toIso?: string, project?: string): string;
  searchRecords(q: string, project?: string): Promise<string>;
  proposeTeam(p: { project: string | null; title: string; instruction: string; brief: string; template_id: string; roles?: TemplateRole[]; priority: Priority; budget_usd?: number | null; note?: string }): string;
  systemStatus(): Promise<string>;
  learn(k: { kind: 'skill' | 'note'; name: string; when_to_use?: string; body: string; source?: string }): string; recall(name: string): string; forget(name: string): string;
  createStanding(p: { name: string; project: string | null; template_id: string; brief: string; roles?: TemplateRole[]; check_command?: string | null; check_interval_sec?: number | null }): string;
  updateStanding(teamId: string, p: { name?: string; brief?: string; check_command?: string | null; check_interval_sec?: number | null }): string;
  endStanding(teamId: string, reason: string): Promise<string>;
  sendToTeam(teamId: string, msg: string): string; setPriority(teamId: string, p: Priority): string; pauseTeam(teamId: string, reason: string): Promise<string>; resumeTeam(teamId: string): Promise<string>; pinTeam(teamId: string, on: boolean): string;
}

export class PoAgent {
  private jobs: Job[] = [];
  private running = false;
  private eventTimer: NodeJS.Timeout | null = null;
  private handle: TurnHandle | null = null;
  busy = false;
  /** 이번 PO 턴에 사용자 메시지가 있는가(직속 팀 생성·종료는 사용자가 시킨 턴에만) */
  private userTurn = false;
  private cancelled = false;

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
        if ((e.type === 'team_reply' || e.type === 'report') && typeof p.answer === 'string') {
          if (p.asked_by === '사용자') return `[사건] 팀 보고(사용자가 팀 채널에서 직접 시킨 일 · 사용자는 이미 답을 받음) · 팀 ${t?.name ?? '-'} (${e.team_id ?? '-'}) · ${String(p.status ?? '')}\n팀 답(참고):\n${truncate(String(p.answer), 800)}`;
          return `[사건] ${EVENT_LABEL[e.type]} · 팀 ${t?.name ?? '-'} (${e.team_id ?? '-'})${p.status ? ` · ${String(p.status)}` : ''}${p.asked ? `\n맡긴 일: ${String(p.asked)}` : ''}\n팀 답:\n${p.answer}`;
        }
        return `[사건] ${EVENT_LABEL[e.type] ?? e.type} · 팀 ${t?.name ?? '-'} (${e.team_id ?? '-'}) · ${truncate(JSON.stringify(p), 400)}`;
      }).join('\n'));
    }
    if (userTexts.length) parts.push(`사용자: ${userTexts.map((t) => forAgent(cfg, t)).join('\n사용자: ')}`);
    const prompt = parts.join('\n\n');
    const prompted = poPrompt(projects, store.listKnowledge());
    if (agent.system_prompt !== prompted) store.updateAgent(agent.id, { system_prompt: prompted });
    const impl = this.tools();
    this.userTurn = userTexts.length > 0;
    this.busy = true;
    bus.changed('po');
    const handle = new TurnHandle();
    this.handle = handle;
    try {
      const resume = agent.session_id;
      const res = await this.deps.runner.runTurn({
        agent: store.poAgent()!, team: null, prompt: resume ? prompt : this.bootstrap() + prompt, cwd: cfg.poDir, systemAppend: prompted,
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', ...PO_TOOL_NAMES], additionalDirectories: [...projects.map((p) => p.path), cfg.uploadsDir], writableRoots: [cfg.poDir],
        blockedPatterns: [...DEFAULT_BLOCKED, ...PO_BLOCKED], heavyPatterns: DEFAULT_HEAVY,
        mcpServers: { hivelane: poMcpServer(impl) }, toolsImpl: impl, settingSources: [], resume, label: 'PO', priority: 'urgent', standing: true,
      }, handle);
      if (this.cancelled) {
        this.cancelled = false;
        store.addChat({ role: 'event', body: '사용자가 PO 응답을 취소함', tone: 'info' });
        return;
      }
      if (res.ok) store.markPoEventsHandled(events.map((e) => e.id));
      if (res.contextTokens > store.getSettings().contextLimitTokens) {
        store.updateAgent(agent.id, { session_id: null });
        log.info(`PO 맥락 ${Math.round(res.contextTokens / 1000)}k → 다음 턴 새 세션`);
      }
      const say = res.text.trim();
      // 팀이 보낸 답(PO 가 맡긴 일의 결과·업무 완료)은 사용자에게 반드시 전해져야 한다
      // 사용자가 팀 채널에서 직접 시킨 일의 완료 보고는 사용자가 이미 받았으니 제외
      const replies = events.filter((e) => e.type === 'team_reply' || (e.type === 'report' && parseJson<Record<string, unknown>>(e.payload, {}).asked_by !== '사용자'));
      const spoke = res.ok && !!say && say !== '-';
      if (!res.ok) store.addChat({ role: 'event', body: `PO 응답 실패: ${res.error ?? res.subtype}`, tone: 'warn' });
      if (spoke) {
        const links = replies.filter((e) => e.team_id).map((e) => ({ label: `${store.getTeam(e.team_id)?.name ?? '팀'} 채널`, href: `#team-${e.team_id}` }));
        store.addChat({ role: 'po', body: say, links: links.length ? links : undefined });
        if (userTexts.length || replies.length) void this.deps.notifier.send({ title: replies.length && !userTexts.length ? 'PO · 팀 답변 전달' : 'PO 답변', body: truncate(say, 300), level: 'info', url: '/#po', tag: 'po-answer', scope: 'po' });
      } else {
        // PO 가 말하지 않았거나 실패했어도 팀 답은 그대로 전한다
        for (const e of replies) {
          const p = parseJson<Record<string, unknown>>(e.payload, {});
          if (typeof p.answer !== 'string') continue;
          const t = store.getTeam(e.team_id);
          store.addChat({ role: 'po', body: `**「${t?.name ?? '팀'}」 답변이 왔습니다**\n\n${truncate(p.answer, 1500)}`, links: e.team_id ? [{ label: '팀 채널 열기', href: `#team-${e.team_id}` }] : undefined, team_id: e.team_id });
          void this.deps.notifier.send({ title: `PO · ${t?.name ?? '팀'} 답변 전달`, body: truncate(p.answer, 300), level: 'info', url: '/#po', tag: 'po-answer', scope: 'po' });
        }
        // 이미 전했으니 다시 처리하지 않는다(실패로 남은 다른 사건은 다음 턴에)
        store.markPoEventsHandled(replies.map((e) => e.id));
      }
      if (!res.ok && agent.session_id && /session|resume/i.test(res.error ?? '')) store.updateAgent(agent.id, { session_id: null });
    } catch (e) {
      log.error('PO 턴 실패', e);
      store.addChat({ role: 'event', body: `PO 오류: ${e instanceof Error ? e.message : e}`, tone: 'warn' });
    } finally {
      this.busy = false;
      this.userTurn = false;
      this.handle = null;
      bus.changed('po');
    }
  }

  async stop(): Promise<void> { await this.handle?.interrupt(); }

  /** 사용자가 진행 중인 PO 응답을 취소: 대기 중인 메시지도 버린다. 돌고 있지 않으면 false. */
  async cancel(): Promise<boolean> {
    const had = this.busy || this.jobs.length > 0;
    this.jobs = this.jobs.filter((j) => j.kind === 'events');
    if (!this.handle) return had;
    this.cancelled = true;
    await this.handle.interrupt();
    return true;
  }

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
    const projectId = (name?: string | null) => (name ? store.findProjectByName(name)?.id ?? null : null);
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
      systemStatus: async () => {
        const meter = new CpuMeter();
        await new Promise((r) => setTimeout(r, 1000));
        const cpu = meter.sample();
        const [procs, mem] = await Promise.all([listProcDetails(), memPercent()]);
        const teamRoots = new Map<number, string>();
        for (const t of store.listTeams("state IN ('running','paused','reviving','idle','waiting_human')"))
          for (const pid of orch.rootPids(t.id)) teamRoots.set(pid, `Hivelane 팀 ${t.id} 「${t.name}」`);
        const input = { procs, cpu, mem, load: loadavg()[0] ?? 0, cores: cpus().length, teamRoots, hivelanePid: process.pid };
        const first = diagnose(input);
        return diagnose({ ...input, cwdOf: await cwdsOf(first.origins) }).text;
      },
      learn: (k) => {
        const { row, created } = store.saveKnowledge(k);
        store.addChat({ role: 'event', body: `PO가 ${created ? '배움' : '고쳐 배움'} · ${row.kind === 'skill' ? '스킬' : '메모'} 「${row.name}」`, tone: 'good' });
        return `${created ? '저장' : '갱신'}했다: ${row.kind} 「${row.name}」 (${row.id})`;
      },
      recall: (name) => {
        const k = store.getKnowledge(name);
        if (!k) return `「${name}」 없음. 배운 목록: ${store.listKnowledge().map((x) => x.name).join(', ') || '(없음)'}`;
        store.touchKnowledge(k.id);
        return `# ${k.name} (${k.kind})\n언제: ${k.when_to_use}\n\n${k.body}`;
      },
      forget: (name) => {
        const k = store.getKnowledge(name);
        if (!k || !store.deleteKnowledge(k.id)) return `「${name}」 없음.`;
        store.addChat({ role: 'event', body: `PO가 잊음 · 「${k.name}」`, tone: 'info' });
        return `지웠다: 「${k.name}」`;
      },
      createStanding: (p) => {
        if (!this.userTurn) return '거절: 직속 팀은 사용자가 이번 대화에서 만들라고 했을 때만 만든다.';
        const pid = projectId(p.project);
        if (p.project && !pid) return `거절: 프로젝트 「${p.project}」 없음. list_projects 로 확인해라.`;
        if (!store.getTemplate(p.template_id)) return `거절: 템플릿 ${p.template_id} 없음.`;
        const t = orch.createStanding({ name: p.name, project_id: pid, template_id: p.template_id, roles: p.roles, brief: p.brief, check_command: p.check_command ?? null, check_interval_sec: p.check_command ? (p.check_interval_sec ?? 300) : null });
        store.addChat({ role: 'event', body: `직속 팀 생성 · 「${t.name}」 (PO가 사용자 지시로 만듦)`, team_id: t.id, tone: 'good' });
        return `직속 팀 ${t.id} 「${t.name}」 를 만들었다. 평소 대기하다가 지시·점검 이상 때 깨어나고, 사용자가 끝내라고 할 때까지 유지된다.`;
      },
      updateStanding: (teamId, p) => {
        const t = store.getTeam(teamId);
        if (!t || t.lifetime !== 'standing') return '직속 팀이 아니다.';
        orch.updateStanding(teamId, { ...p, ...(p.check_command ? { check_interval_sec: p.check_interval_sec ?? t.check_interval_sec ?? 300 } : {}) });
        return '바꿨다.';
      },
      endStanding: async (teamId, reason) => {
        if (!this.userTurn) return '거절: 직속 팀 종료는 사용자가 이번 대화에서 끝내라고 했을 때만 한다.';
        const t = store.getTeam(teamId);
        if (!t || t.lifetime !== 'standing') return '직속 팀이 아니다.';
        await orch.endStanding(teamId, 'agent', `PO(사용자 지시): ${reason}`);
        store.addChat({ role: 'event', body: `직속 팀 종료 · 「${t.name}」 (사용자 지시로 PO가 종료)`, team_id: teamId, tone: 'info' });
        return `직속 팀 「${t.name}」 를 종료했다.`;
      },
      sendToTeam: (teamId, msg) => { if (!store.getTeam(teamId)) return '없는 팀이다.'; const r = orch.message(teamId, msg, 'po'); return r === 'delivered' ? '전달했다.' : '팀이 멈춰 있어 재개될 때 전달된다.'; },
      setPriority: (teamId, p) => { orch.setPriority(teamId, p, 'agent'); return `우선순위를 ${p}로 바꿨다.`; },
      pauseTeam: async (teamId, reason) => { await orch.pause(teamId, 'user', `PO: ${reason}`); return '멈췄다.'; },
      resumeTeam: async (teamId) => { await orch.resume(teamId, 'user', 'PO 재개'); return '재개했다.'; },
      pinTeam: (teamId, on) => { orch.pin(teamId, on, 'agent'); return on ? '멈추지 않음으로 설정했다.' : '해제했다.'; },
    };
  }
}

const PO_TOOL_NAMES = ['list_projects', 'list_templates', 'list_teams', 'get_task_status', 'find_changes', 'get_timeline', 'search_records', 'propose_team', 'system_status', 'learn', 'recall', 'forget', 'create_standing_team', 'update_standing_team', 'end_standing_team', 'send_to_team', 'set_priority', 'pause_team', 'resume_team', 'pin_team'].map((n) => `mcp__hivelane__${n}`);

/** PO 의 Bash 는 진단·조회용. 프로세스 종료·시스템 변경은 사람 몫. */
export const PO_BLOCKED = ['\\b(kill|pkill|killall)\\b', '\\blaunchctl\\s+(unload|load|bootout|bootstrap|remove|kill|stop|disable)', '\\b(shutdown|reboot|halt)\\b', '\\bdefaults\\s+write\\b', '\\bnpm\\s+(i|install|ci|uninstall)\\b', '\\bbrew\\s+(install|uninstall|upgrade|remove)\\b', '\\btailscale\\s+(up|down|serve|funnel|logout)'];

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
      budget_usd: z.number().optional().describe('사용자가 상한을 말했을 때만. 없으면 설정 기본값(기본 무제한)'), note: z.string().optional().describe('사용자에게 보일 한두 문장'),
    }, async (a) => text(impl.proposeTeam({ ...a, project: a.project ?? null, roles: a.roles as TemplateRole[] | undefined }))),
    T('system_status', '맥 전체 CPU·메모리와 누가 쓰고 있는지(출처별 합계: Claude Code 세션·앱·Hivelane 팀, CPU·메모리 상위 프로세스, 작업 디렉토리). 리소스 질문엔 먼저 이것', {}, async () => text(await impl.systemStatus())),
    T('learn', '배운 것을 저장한다(같은 이름이면 고쳐 씀). skill = 해 보고 확인한 절차(언제 쓰는지 + 단계·명령·판단 기준), note = 늘 기억할 사실·선호. 비밀값은 저장 금지', {
      kind: z.enum(['skill', 'note']), name: z.string().min(1).max(80).describe('짧은 이름(예: cpu-원인-찾기)'),
      when_to_use: z.string().max(500).optional().describe('언제 꺼내 쓰는지 한 문장'), body: z.string().min(1).max(20000).describe('마크다운 본문'), source: z.string().max(500).optional().describe('출처(사용자 지시·문서 경로·URL)'),
    }, async (a) => text(impl.learn(a))),
    T('recall', '배운 스킬 본문을 꺼낸다. 해당 상황이면 일하기 전에 먼저', { name: z.string() }, async (a) => text(impl.recall(a.name))),
    T('forget', '배운 것을 지운다(사용자가 잊으라고 할 때, 틀린 것으로 확인됐을 때)', { name: z.string() }, async (a) => text(impl.forget(a.name))),
    T('create_standing_team', '직속 팀을 바로 만든다(승인 카드 없음). 사용자가 이번 대화에서 만들라고 했을 때만. 직속 팀은 평소 대기, 지시·점검 이상 때 깨어나며 사용자가 끝내라고 할 때까지 유지된다', {
      name: z.string().min(1).max(60), project: z.string().nullable().describe('프로젝트 id 또는 이름. 없으면 null(모든 프로젝트 읽기)'),
      template_id: z.string().describe('list_templates 에서. 운영·점검이면 tpl-ops'), brief: z.string().min(1).max(8000).describe('상시 지시서: 맡은 역할·평소 할 일·이상 시 대응·보고 기준'),
      roles: z.array(roleSchema).optional().describe('템플릿 역할을 바꿀 때만'),
      check_command: z.string().max(2000).nullable().optional().describe('선택: 주기 점검 쉘 명령(종료 코드≠0 이면 팀을 깨움). 읽기 명령만'), check_interval_sec: z.number().int().min(30).max(86400).optional(),
    }, async (a) => text(impl.createStanding({ ...a, project: a.project ?? null, roles: a.roles as TemplateRole[] | undefined }))),
    T('update_standing_team', '직속 팀의 이름·상시 지시서·점검 명령/주기를 바꾼다', { team_id: z.string(), name: z.string().max(60).optional(), brief: z.string().max(8000).optional(), check_command: z.string().max(2000).nullable().optional(), check_interval_sec: z.number().int().min(30).max(86400).optional() },
      async (a) => { const { team_id, ...rest } = a; return text(impl.updateStanding(team_id, rest)); }),
    T('end_standing_team', '직속 팀을 종료(보관)한다. 사용자가 이번 대화에서 그 팀을 끝내라고 명시했을 때만. 그 밖의 이유(한가함·오류·리소스)로는 절대 끝내지 않는다', { team_id: z.string(), reason: z.string().describe('사용자 요청 원문 요약') },
      async (a) => text(await impl.endStanding(a.team_id, a.reason))),
    T('send_to_team', '팀 PM 에게 말을 전한다', { team_id: z.string(), message: z.string() }, async (a) => text(impl.sendToTeam(a.team_id, a.message))),
    T('set_priority', '팀 우선순위 변경', { team_id: z.string(), priority: z.enum(['urgent', 'normal', 'low']) }, async (a) => text(impl.setPriority(a.team_id, a.priority))),
    T('pause_team', '팀을 멈춘다(근거 필요)', { team_id: z.string(), reason: z.string() }, async (a) => text(await impl.pauseTeam(a.team_id, a.reason))),
    T('resume_team', '멈춘 팀을 재개', { team_id: z.string() }, async (a) => text(await impl.resumeTeam(a.team_id))),
    T('pin_team', '「멈추지 않음」 설정/해제', { team_id: z.string(), on: z.boolean() }, async (a) => text(impl.pinTeam(a.team_id, a.on))),
  ];
  return createSdkMcpServer({ name: 'hivelane', version: '0.1.0', tools });
}
