import { spawn } from 'node:child_process';
import {
  query, type AgentDefinition, type HookCallbackMatcher, type HookInput, type HookJSONOutput, type McpServerConfig, type Options, type Query,
  type SDKMessage, type SpawnedProcess, type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../log.ts';
import type { AgentRow, Store, TeamRow } from '../store.ts';
import { truncate } from '../util.ts';
import { checkBash, checkWritePath, describeTool, isHeavy, WRITE_TOOLS } from './guard.ts';
import type { HeavySlots } from '../po/slots.ts';
import type { Priority } from '../../shared/types.ts';

const log = logger('runner');

export interface TurnSpec {
  agent: AgentRow;
  team: TeamRow | null;
  prompt: string;
  cwd: string;
  systemAppend: string;
  allowedTools: string[];
  additionalDirectories?: string[];
  writableRoots?: string[];
  heavyPatterns?: string[];
  blockedPatterns?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  subagents?: Record<string, AgentDefinition & { roleAgentId: string; roleName: string }>;
  settingSources?: Options['settingSources'];
  /** 내 Claude Code 와 같은 환경: 사용자 설정·플러그인·MCP 를 불러오고 역할별 도구 제한 없이 */
  envMine?: boolean;
  /** 사람 승인 뒤에만 실행하는 명령 패턴과 승인된 명령 확인(한 번 쓰면 소진) */
  approval?: { patterns: string[]; take(command: string): boolean };
  resume?: string | null;
  maxBudgetUsd?: number | null;
  priority?: Priority;
  standing?: boolean;
  /** PreToolUse 마다 불려 사용자 지시처럼 끼워 넣을 문장을 돌려준다. */
  injectContext?: () => string | null;
  label?: string;
  /** MCP 서버 뒤의 실제 구현. 가짜 러너(테스트)가 직접 부른다. */
  toolsImpl?: unknown;
}

export interface TurnResult {
  ok: boolean;
  subtype: string;
  text: string;
  costUsd: number;
  sessionId: string | null;
  interrupted: boolean;
  error: string | null;
  contextTokens: number;
}

/** 실행 중인 턴 하나. 멈춤·강한 멈춤에 쓴다. */
export class TurnHandle {
  q: Query | null = null;
  pid: number | null = null;
  pauseRequested = false;
  interrupted = false;
  readonly releases = new Map<string, () => void>();
  readonly abort = new AbortController();
  /** 턴이 끝났다(이후 받은 자리는 즉시 반납) */
  done = false;

  async interrupt(): Promise<void> {
    this.pauseRequested = true;
    this.interrupted = true;
    const q = this.q;
    if (!q) return;
    // 응답이 없으면(프로세스 정지·멈춤 등) 5초 뒤 강제 종료
    const ok = await Promise.race([q.interrupt().then(() => true, (e) => { log.warn('interrupt 실패', e); return false; }), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (!ok && !this.done) { log.warn('interrupt 응답 없음 → 턴 강제 종료'); this.abort.abort(); }
  }
  releaseAll(): void {
    for (const r of this.releases.values()) r();
    this.releases.clear();
  }
}

export interface RunnerDeps {
  store: Store;
  slots: HeavySlots;
  pathToClaude?: string;
  /** 스트림에 플랜 한도 이벤트가 오면(사용량 갱신 신호) */
  onRateLimit?: () => void;
}

const PRESET_TOOLS = {
  pm: ['Read', 'Glob', 'Grep', 'Agent', 'TodoWrite'],
  write: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'TodoWrite'],
  verify: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
  read: ['Read', 'Glob', 'Grep'],
} as const;
export function presetTools(p: keyof typeof PRESET_TOOLS): string[] { return [...PRESET_TOOLS[p]]; }

/** Agent SDK 한 턴(=query 하나)을 실행하고 모든 진행을 DB·버스에 남긴다. */
export class AgentRunner {
  constructor(private deps: RunnerDeps) {}

  async runTurn(spec: TurnSpec, handle: TurnHandle = new TurnHandle()): Promise<TurnResult> {
    const { store } = this.deps;
    const team = spec.team;
    const teamId = team?.id ?? null;
    const writable = spec.writableRoots ?? [spec.cwd];
    const toolOwner = new Map<string, string>(); // tool_use_id → agent id (서브에이전트 귀속)
    const subByType = new Map<string, string>(); // subagent_type → role agent id
    const subLabel = new Map<string, string>();
    for (const [k, d] of Object.entries(spec.subagents ?? {})) { subByType.set(k, d.roleAgentId); subLabel.set(k, d.roleName); }
    const agentTaskUse = new Map<string, string>(); // Agent tool_use_id → subagent_type

    const ownerOf = (input: HookInput): string => {
      const t = (input as { agent_type?: string }).agent_type;
      return (t && subByType.get(t)) || spec.agent.id;
    };
    // 역할별로 쓸 수 있는 도구(세션 권한은 합집합으로 주고, 여기서 역할마다 좁힌다)
    const toolsOf = (input: HookInput): string[] => {
      const t = (input as { agent_type?: string }).agent_type;
      const sub = t ? spec.subagents?.[t] : undefined;
      return sub ? sub.tools ?? [] : spec.allowedTools;
    };

    const preTool = async (input: HookInput, toolUseId: string | undefined, { signal }: { signal: AbortSignal }): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const tool = input.tool_name;
      const id = toolUseId ?? input.tool_use_id;
      const owner = ownerOf(input);
      const deny = (reason: string): HookJSONOutput => {
        store.addAgentEvent({ agent_id: owner, team_id: teamId, kind: 'denied', name: tool, body: reason });
        store.endRun(id, 'denied');
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
      };
      if (handle.pauseRequested) return deny('팀이 일시정지되었습니다. 지금 하던 일을 멈추고 기다려라.');
      const mine = toolsOf(input);
      if (!spec.envMine && !tool.startsWith('mcp__') && tool !== 'ToolSearch' && !mine.includes(tool)) {
        return deny(`이 역할은 ${tool} 도구를 쓸 수 없습니다(쓸 수 있는 도구: ${mine.join(', ')}). ${tool in WRITE_TOOLS || tool === 'Bash' ? '구현·실행은 그 도구가 있는 팀원에게 맡겨라. ' : ''}맡길 팀원이 없으면 PM 이 mcp__hivelane__request_tools 로 사람에게 임시 권한을 요청한다(실패로 끝내지 말 것).`);
      }
      if (tool === 'Agent' || tool === 'Task') {
        // 서브에이전트는 끝날 때까지 기다리게 한다(백그라운드·격리 실행 금지)
        const inp: Record<string, unknown> = { ...(input.tool_input as Record<string, unknown>), run_in_background: false };
        delete inp.isolation; delete inp.team_name; delete inp.mode;
        store.updateAgent(owner, { state: 'busy', current_step: describeTool(tool, inp) });
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: inp } };
      }
      if (tool in WRITE_TOOLS) {
        const r = checkWritePath(tool, input.tool_input, input.cwd || spec.cwd, writable);
        if (r) return deny(r);
      }
      let extra: string | null = null;
      if (tool === 'Bash') {
        const cmd = String((input.tool_input as { command?: unknown })?.command ?? '');
        const r = checkBash(cmd, input.cwd || spec.cwd, writable, spec.blockedPatterns ?? []);
        if (r) return deny(r);
        const needs = spec.approval?.patterns.find((p) => { try { return new RegExp(p).test(cmd); } catch { return false; } });
        if (needs) {
          if (!spec.approval!.take(cmd.trim())) return deny(`사람 승인이 필요한 명령입니다(패턴: ${needs}). mcp__hivelane__request_approval(command=이 명령 그대로, reason=이유) 로 승인을 요청하고 턴을 끝내라. 승인되면 같은 명령을 그대로 다시 실행한다.`);
          store.addAgentEvent({ agent_id: owner, team_id: teamId, kind: 'note', name: 'Bash', body: `사람 승인된 명령 실행: ${truncate(cmd, 200)}` });
        }
        if (isHeavy(cmd, spec.heavyPatterns ?? [])) {
          const started = Date.now();
          store.updateAgent(owner, { current_step: `무거운 명령 대기 (${this.deps.slots.waitingPosition(teamId ?? '') || '…'}번째)`, state: 'busy' });
          store.addAgentEvent({ agent_id: owner, team_id: teamId, kind: 'wait', name: 'Bash', body: `무거운 명령 자리 대기: ${truncate(cmd, 120)}` });
          try {
            const release = await this.deps.slots.acquire(teamId ?? 'po', spec.priority ?? 'normal', !!spec.standing, AbortSignal.any([signal, handle.abort.signal]));
            if (handle.done) { release(); return deny('턴이 끝났습니다.'); }
            handle.releases.set(id, release);
          } catch {
            return deny('무거운 명령 대기가 취소되었습니다(팀 멈춤).');
          }
          const waited = Date.now() - started;
          if (waited > 1000) store.addAgentEvent({ agent_id: owner, team_id: teamId, kind: 'wait', name: 'Bash', body: `자리 받음 · ${Math.round(waited / 1000)}초 대기` });
          store.addRunWait(id, waited);
          if (handle.pauseRequested) { handle.releases.get(id)?.(); handle.releases.delete(id); return deny('팀이 일시정지되었습니다.'); }
        }
      }
      store.updateAgent(owner, { state: 'busy', current_step: describeTool(tool, input.tool_input) });
      if (team) store.touchTeam(team.id);
      // 사람 지시는 PM(메인 스레드)에게만 끼워 넣는다. 서브에이전트가 가져가면 PM 이 못 본다.
      const inj = (input as { agent_type?: string }).agent_type ? null : spec.injectContext?.();
      if (inj) extra = inj;
      // 내 환경 모드: 가드를 통과한 도구는 권한 목록과 상관없이 허용(사용자 MCP·플러그인 도구 포함)
      if (spec.envMine) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(extra ? { additionalContext: extra } : {}) } };
      return extra ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: extra } } : {};
    };
    const postTool = async (input: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
      const id = toolUseId ?? (input as { tool_use_id?: string }).tool_use_id ?? '';
      const rel = handle.releases.get(id);
      if (rel) { rel(); handle.releases.delete(id); }
      store.endRun(id, input.hook_event_name === 'PostToolUseFailure' ? 'error' : 'ok');
      return {};
    };
    const hookTimeout = 24 * 3600;
    const hooks: Partial<Record<'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', HookCallbackMatcher[]>> = {
      PreToolUse: [{ hooks: [preTool], timeout: hookTimeout }],
      PostToolUse: [{ hooks: [postTool], timeout: 30 }],
      PostToolUseFailure: [{ hooks: [postTool], timeout: 30 }],
    };

    const agents: Record<string, AgentDefinition> = {};
    const union = new Set(spec.allowedTools);
    for (const [k, d] of Object.entries(spec.subagents ?? {})) {
      const { roleAgentId: _a, roleName: _b, ...def } = d;
      agents[k] = { ...def, background: false };
      for (const t of def.tools ?? []) union.add(t);
    }
    if (Object.keys(agents).length) union.add('Agent');
    union.add('ToolSearch');

    const options: Options = {
      cwd: spec.cwd,
      model: spec.agent.model,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemAppend },
      settingSources: spec.settingSources ?? (spec.envMine ? ['user', 'project', 'local'] : ['project', 'local']),
      permissionMode: 'dontAsk',
      allowedTools: [...union],
      tools: spec.envMine ? undefined : [...union].filter((t) => !t.startsWith('mcp__')),
      additionalDirectories: spec.additionalDirectories,
      mcpServers: spec.mcpServers,
      agents: Object.keys(agents).length ? agents : undefined,
      resume: spec.resume ?? undefined,
      maxBudgetUsd: spec.maxBudgetUsd ?? undefined,
      hooks,
      abortController: handle.abort,
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000), CLAUDE_AGENT_SDK_CLIENT_APP: 'hivelane/0.1' },
      stderr: (d: string) => { if (d.trim()) log.debug(`claude stderr (${spec.agent.role_key})`, truncate(d.trim(), 400)); },
      spawnClaudeCodeProcess: (o: SpawnOptions): SpawnedProcess => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        handle.pid = child.pid ?? null;
        child.stderr?.on('data', (b: Buffer) => { const s = b.toString().trim(); if (s) log.debug(`claude(${spec.agent.role_key})`, truncate(s, 300)); });
        return child as unknown as SpawnedProcess;
      },
    };
    if (this.deps.pathToClaude) options.pathToClaudeCodeExecutable = this.deps.pathToClaude;

    store.updateAgent(spec.agent.id, { state: 'busy', current_step: '생각 중' });
    const result: TurnResult = { ok: false, subtype: 'unknown', text: '', costUsd: 0, sessionId: spec.resume ?? null, interrupted: false, error: null, contextTokens: 0 };
    let lastText = '';
    try {
      const q = query({ prompt: spec.prompt, options });
      handle.q = q;
      for await (const m of q) this.onMessage(m, spec, { toolOwner, agentTaskUse, subByType, subLabel, teamId, result, setLastText: (t) => { lastText = t; } });
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      result.subtype = handle.interrupted ? 'interrupted' : 'exception';
      log.warn(`턴 예외 (${spec.agent.role_key}${teamId ? ' · ' + teamId : ''})`, result.error);
    } finally {
      handle.done = true;
      handle.releaseAll();
      handle.q = null;
      handle.pid = null;
    }
    result.interrupted = handle.interrupted;
    if (!result.text) result.text = lastText;
    for (const id of new Set([spec.agent.id, ...subByType.values()])) store.updateAgent(id, { state: handle.pauseRequested ? 'stop' : 'idle', current_step: handle.pauseRequested ? '일시정지' : result.ok ? '턴 완료' : '대기' });
    if (result.sessionId) store.updateAgent(spec.agent.id, { session_id: result.sessionId });
    return result;
  }

  private onMessage(m: SDKMessage, spec: TurnSpec, c: {
    toolOwner: Map<string, string>; agentTaskUse: Map<string, string>; subByType: Map<string, string>; subLabel: Map<string, string>;
    teamId: string | null; result: TurnResult; setLastText: (t: string) => void;
  }): void {
    const { store } = this.deps;
    const pmLabel = spec.label ?? spec.agent.role_name;
    if (m.type === 'rate_limit_event') { this.deps.onRateLimit?.(); return; }
    if (m.type === 'system' && m.subtype === 'init') {
      c.result.sessionId = m.session_id;
      store.updateAgent(spec.agent.id, { session_id: m.session_id });
      return;
    }
    if (m.type === 'assistant') {
      const parent = m.parent_tool_use_id;
      const subType = parent ? c.agentTaskUse.get(parent) : undefined;
      const owner = (subType && c.subByType.get(subType)) || spec.agent.id;
      if (!parent) {
        // 지금 맥락 크기 = 메인 스레드 마지막 응답의 입력 토큰(캐시 포함). result.usage 는 턴 안 모든 호출의 합이라 쓰지 않는다.
        const u = m.message.usage as { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined;
        if (u) c.result.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text.trim()) {
          store.addAgentEvent({ agent_id: owner, team_id: c.teamId, kind: 'text', body: b.text });
          if (!parent) c.setLastText(b.text);
        } else if (b.type === 'thinking' && 'thinking' in b && typeof b.thinking === 'string' && b.thinking.trim()) {
          store.addAgentEvent({ agent_id: owner, team_id: c.teamId, kind: 'think', body: truncate(b.thinking, 2000) });
        } else if (b.type === 'tool_use') {
          c.toolOwner.set(b.id, owner);
          const input = b.input as Record<string, unknown>;
          const cmd = b.name === 'Bash' ? String(input.command ?? '') : (input.file_path as string | undefined) ?? (input.pattern as string | undefined) ?? null;
          store.startRun({ agent_id: owner, team_id: c.teamId, tool_use_id: b.id, tool: b.name, command: cmd ? truncate(cmd, 2000) : null });
          store.addAgentEvent({ agent_id: owner, team_id: c.teamId, kind: 'tool_use', name: b.name, body: describeTool(b.name, input) + (b.name === 'Bash' ? `\n$ ${truncate(String(input.command ?? ''), 1500)}` : '') });
          if ((b.name === 'Agent' || b.name === 'Task') && typeof input.subagent_type === 'string') {
            c.agentTaskUse.set(b.id, input.subagent_type);
            const subId = c.subByType.get(input.subagent_type);
            const label = c.subLabel.get(input.subagent_type) ?? input.subagent_type;
            if (subId) store.updateAgent(subId, { state: 'busy', current_step: truncate(String(input.description ?? '작업 시작'), 80) });
            if (c.teamId) store.addMessage({ team_id: c.teamId, from_label: pmLabel, to_label: label, kind: 'handoff', body: String(input.prompt ?? input.description ?? '') });
          }
        }
      }
      return;
    }
    if (m.type === 'user' && m.parent_tool_use_id) {
      // 서브에이전트 안쪽 도구 결과: 그 서브에이전트 기록으로만 남긴다
      const sub = c.agentTaskUse.get(m.parent_tool_use_id);
      const owner = (sub && c.subByType.get(sub)) || spec.agent.id;
      const content = m.message.content;
      if (Array.isArray(content)) for (const b of content) {
        if (typeof b === 'object' && b && (b as { type?: string }).type === 'tool_result') {
          const tr = b as { content?: unknown; is_error?: boolean };
          store.addAgentEvent({ agent_id: owner, team_id: c.teamId, kind: tr.is_error ? 'tool_error' : 'tool_result', body: truncate(toolResultText(tr.content), 2000) });
        }
      }
      return;
    }
    if (m.type === 'user' && !m.parent_tool_use_id) {
      const content = m.message.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (typeof b !== 'object' || b === null || (b as { type?: string }).type !== 'tool_result') continue;
        const tr = b as { tool_use_id: string; content?: unknown; is_error?: boolean };
        const sub = c.agentTaskUse.get(tr.tool_use_id);
        const raw = toolResultText(tr.content);
        const text = sub ? cleanSubagentText(raw) : raw;
        const owner = c.toolOwner.get(tr.tool_use_id) ?? spec.agent.id;
        store.addAgentEvent({ agent_id: owner, team_id: c.teamId, kind: tr.is_error ? 'tool_error' : 'tool_result', body: truncate(text, 4000) });
        if (sub) {
          const subId = c.subByType.get(sub);
          const label = c.subLabel.get(sub) ?? sub;
          if (subId) store.updateAgent(subId, { state: 'idle', current_step: tr.is_error ? '실패로 끝남' : '보고 완료' });
          if (c.teamId) store.addMessage({ team_id: c.teamId, from_label: label, to_label: pmLabel, kind: 'report', body: truncate(text, 6000) });
        }
      }
      return;
    }
    if (m.type === 'result') {
      c.result.subtype = m.subtype;
      c.result.ok = m.subtype === 'success' && !m.is_error;
      c.result.costUsd = m.total_cost_usd ?? 0;
      c.result.sessionId = m.session_id;
      if (m.subtype === 'success') c.result.text = m.result;
      else c.result.error = m.subtype === 'error_max_budget_usd' ? '예산 상한에 도달했습니다' : `실행 오류: ${m.subtype}`;
      const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      const billedIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      store.addAgentUsage(spec.agent.id, { cost: c.result.costUsd, inTok: billedIn, outTok: u.output_tokens ?? 0, context: c.result.contextTokens });
      if (c.teamId) store.addTeamCost(c.teamId, c.result.costUsd);
      store.addAgentEvent({ agent_id: spec.agent.id, team_id: c.teamId, kind: 'result', body: `${c.result.ok ? '턴 완료' : c.result.error ?? m.subtype} · $${c.result.costUsd.toFixed(3)} · ${m.num_turns}턴` });
    }
  }
}

/** 서브에이전트 결과에 SDK 가 붙이는 틀(머리말·도구 목록·사용량)을 걷어 내고 보고 본문만 남긴다. */
export function cleanSubagentText(t: string): string {
  let s = t.replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g, '');
  const head = s.indexOf('[Subagent hand-back]');
  if (head >= 0) {
    const follows = s.indexOf('The report follows:', head);
    s = follows >= 0 ? s.slice(follows + 'The report follows:'.length) : s.slice(head);
  }
  s = s.replace(/\n?agentId:\s*\S+\s*/g, '\n').replace(/<usage>[\s\S]*?<\/usage>/g, '');
  const lines = s.split('\n');
  const indented = lines.filter((l) => l.trim()).every((l) => l.startsWith('  '));
  return (indented ? lines.map((l) => l.slice(2)) : lines).join('\n').trim();
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((x) => (typeof x === 'object' && x && 'text' in x ? String((x as { text: unknown }).text) : '')).join('\n');
  return '';
}
