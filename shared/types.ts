/** 서버와 화면이 함께 쓰는 타입. */

export type Priority = 'urgent' | 'normal' | 'low';
export type Model = 'opus' | 'sonnet' | 'haiku';
export type RunMode = 'session' | 'subagent';
export type ToolPreset = 'pm' | 'write' | 'verify' | 'read';
export type Zone = 'green' | 'yellow' | 'red';

/** 팀 상태. standing 팀은 idle(대기)·running·down·reviving 을 쓴다. */
export type TeamState = 'queued' | 'running' | 'paused' | 'waiting_human' | 'done' | 'failed' | 'idle' | 'down' | 'reviving' | 'archived';
export type AgentState = 'idle' | 'busy' | 'stop';
export type Stage = 0 | 1 | 2 | 3 | 4; // 기획 구현 검사 보고 (4 = 끝)
export const STAGES = ['기획', '구현', '검사', '보고'] as const;

export interface TemplateRole {
  key: string;          // 팀 안에서 유일: pm, dev, dev2, qa ...
  name: string;         // 화면 이름: PM, 개발, QA ...
  model: Model;
  mode: RunMode;        // pm 은 항상 session
  tools: ToolPreset;
  prompt?: string;      // 비우면 역할 기본 프롬프트
}

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  roles: TemplateRole[];
  builtin: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  base_ref: string;
  deps_strategy: 'symlink' | 'install' | 'none';
  heavy_patterns: string[];
  blocked_patterns: string[];
  memory_paths: string[];
  default_template_id: string | null;
}

export interface EngineSettings {
  cap: number;
  slotsGreen: number;
  slotsYellow: number;
  cpuY: number;
  cpuR: number;
  memY: number;
  memR: number;
  memHard: number;
  sustainSec: number;
  resumeSec: number;
  hardPauseSec: number;
  pauseEverySec: number;
  stallMin: number;
  beatSec: number;
}

export interface Settings {
  engine: EngineSettings;
  autoApprove: boolean;
  defaultBudgetUsd: number;
  poModel: Model;
  contextLimitTokens: number;
  ownerLogin: string | null;
  slackWebhook: string | null;
  embedding: { provider: 'off' | 'ollama' | 'voyage'; model: string; url: string };
}

export const DEFAULT_SETTINGS: Settings = {
  engine: {
    cap: 3, slotsGreen: 2, slotsYellow: 1,
    cpuY: 70, cpuR: 85, memY: 75, memR: 85, memHard: 95,
    sustainSec: 30, resumeSec: 120, hardPauseSec: 120, pauseEverySec: 60,
    stallMin: 20, beatSec: 60,
  },
  autoApprove: false,
  defaultBudgetUsd: 20,
  poModel: 'opus',
  contextLimitTokens: 150_000,
  ownerLogin: null,
  slackWebhook: null,
  embedding: { provider: 'off', model: 'bge-m3', url: 'http://127.0.0.1:11434' },
};

export interface AgentView {
  id: string;
  team_id: string | null;
  role_key: string;
  role_name: string;
  model: Model;
  run_mode: RunMode;
  state: AgentState;
  current_step: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  session_id: string | null;
}

export interface TeamView {
  id: string;
  task_id: string | null;
  project_id: string | null;
  project_name: string | null;
  name: string;
  title: string;
  managed_by: 'po' | 'user';
  lifetime: 'task' | 'standing';
  state: TeamState;
  stage: number;
  priority: Priority;
  pinned: boolean;
  paused_reason: string | null;
  question: { text: string; options: string[]; asked_at: string } | null;
  cost_usd: number;
  budget_usd: number | null;
  branch: string | null;
  worktree_path: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  last_activity_at: string | null;
  last_heartbeat_at: string | null;
  revived_count: number;
  standing_brief: string;
  check_command: string | null;
  check_interval_sec: number | null;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  readable_team_ids: string[];
  agents: AgentView[];
  busy_note: string | null;
}

export interface ProposalView {
  id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  instruction: string;
  brief: string;
  template_id: string | null;
  template_name: string | null;
  roles: TemplateRole[];
  priority: Priority;
  budget_usd: number | null;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  task_id: string | null;
}

export interface ChatView {
  id: number;
  role: 'user' | 'po' | 'event';
  body: string;
  proposal_id: string | null;
  links: { label: string; href: string }[];
  tone: string | null;
  team_id: string | null;
  created_at: string;
}

export interface ResourceView {
  cpu: number;
  mem: number;
  zone: Zone;
  heavyRunning: number;
  heavyWaiting: number;
  takenAt: string;
}

export interface StateSnapshot {
  version: string;
  access: 'local' | 'remote';
  settings: Settings;
  resource: ResourceView;
  projects: Project[];
  templates: TeamTemplate[];
  teams: TeamView[];
  proposals: ProposalView[];
  poBusy: boolean;
  vapidPublicKey: string | null;
}

export interface TeamDetail {
  team: TeamView;
  messages: { id: number; from_label: string; to_label: string | null; kind: string; body: string; created_at: string }[];
  checklist: { idx: number; text: string; done: boolean }[];
  files: { path: string; change_type: string; lines_added: number; lines_removed: number }[];
  decisions: { id: number; actor: string; action: string; reason: string; created_at: string }[];
  summaries: { stage: string; body: string; created_at: string }[];
}

export interface AgentDetail {
  agent: AgentView & { system_prompt: string; allowed_tools: string[] };
  events: { id: number; kind: string; name: string | null; body: string; created_at: string }[];
  runs: { id: number; tool: string; command: string | null; status: string; waited_ms: number; started_at: string; ended_at: string | null }[];
}

export const TOOL_PRESET_LABEL: Record<ToolPreset, string> = {
  pm: '읽기·검색, 팀 지휘(delegate·ask·report)',
  write: '읽기·쓰기·Bash (커밋·푸시·운영 명령 차단)',
  verify: '읽기·Bash (검사 명령)',
  read: '읽기·검색만',
};
