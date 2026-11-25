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
  /** 이 역할이 쓸 AI 계정 id. 비우면 설정의 기본 계정. Agent 도구로 부르는 팀원(subagent)은 PM 과 같은 계정을 쓴다 */
  account?: string | null;
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
  /** none: 커밋·푸시·PR 막음 · push: 커밋·푸시·PR 만들기 허용(보호 브랜치 푸시·강제 푸시·PR 병합은 막음) */
  git_mode: 'none' | 'push';
  /** git_mode=push 일 때 팀이 직접 푸시하면 안 되는 브랜치 */
  protected_branches: string[];
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
  /** null = 무제한 */
  defaultBudgetUsd: number | null;
  poModel: Model;
  contextLimitTokens: number;
  ownerLogin: string | null;
  slackWebhook: string | null;
  /** 읽지 않은 답변이 있으면 이 간격(분)마다 다시 알림. 0 = 끔 */
  remindUnreadMin: number;
  embedding: { provider: 'off' | 'ollama' | 'voyage'; model: string; url: string };
  /** 끝난 업무 팀의 worktree 를 이 일수가 지나면 변경을 패치로 남기고 자동 정리. 0 = 끔 */
  autoCleanDays: number;
  /** 기본 AI 계정 id(역할에 계정을 안 고르면 이것) */
  defaultAccount: string;
  /** 총괄이 쓸 계정 id. null = 기본 계정 */
  poAccount: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: {
    cap: 3, slotsGreen: 2, slotsYellow: 1,
    cpuY: 70, cpuR: 85, memY: 75, memR: 85, memHard: 95,
    sustainSec: 30, resumeSec: 120, hardPauseSec: 120, pauseEverySec: 60,
    stallMin: 20, beatSec: 60,
  },
  autoApprove: false,
  defaultBudgetUsd: null,
  remindUnreadMin: 30,
  poModel: 'opus',
  defaultAccount: 'default',
  poAccount: null,
  contextLimitTokens: 150_000,
  ownerLogin: null,
  slackWebhook: null,
  embedding: { provider: 'off', model: 'bge-m3', url: 'http://127.0.0.1:11434' },
  autoCleanDays: 7,
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
  /** engine-soft | engine-hard | user | null */
  pause_kind: string | null;
  /** 사람이 재개해서 자동 멈춤에서 보호되는 시각(이때까지) */
  resume_grace_until?: string | null;
  /** 내가 아직 안 본 PM 답변·보고·질문 수 */
  unread: number;
  /** isolated: 저장소 규칙만 · mine: 내 Claude Code 설정·플러그인·MCP·메모리 쓰기 + 운영 명령은 승인 후 실행 */
  env_mode: 'isolated' | 'mine';
  /** 마지막 PM 답·보고·질문(채널 목록·새 소식 미리보기) */
  last_msg: { body: string; kind: string; to: string | null; at: string } | null;
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
  /** 팀을 만든 템플릿(직속 팀은 kv standing_tpl:팀id · 업무 팀은 업무의 템플릿 · 모르면 null) */
  template_id: string | null;
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

/** 저장 공간 */
export interface StorageView {
  takenAt: string; home: string;
  db: { file: number; wal: number; shm: number; free: number };
  groups: { label: string; note: string; bytes: number }[];
  counts: { teams: number; messages: number; events: number; chat: number; docs: number; patches: number };
  dirs: { key: string; label: string; path: string; bytes: number | null; note: string }[];
}

/** 검색 색인 상태 */
export interface SearchStatusView {
  vecReady: boolean; enabled: boolean; provider: string; model: string; dim: number | null;
  /** 전문 검색에 들어간 기록 수 · 그중 벡터로도 들어간 수 */
  docs: number; vectors: number;
  /** 지금 벡터를 만든 방식·모델(다르면 다시 색인 필요) */
  indexedWith: { provider: string | null; model: string } | null; modelMismatch: boolean;
  lastFullAt: string | null; lastFullCount: number | null; lastAddAt: string | null;
  lastError: string | null; lastErrorAt: string | null;
  job: { running: boolean; done: number; total: number; error: string | null; startedAt: string } | null;
}

/** 벡터 검색용 Ollama 상태(설치·실행·모델·진행 중 작업) */
export interface OllamaView {
  brew: boolean; installed: boolean; running: boolean; version: string | null;
  /** Hivelane 이 띄운 ollama serve 인가(아니면 앱·brew services 등 다른 데서 돌고 있음) */
  managed: boolean; local: boolean;
  model: string; hasModel: boolean; models: string[];
  job: { kind: 'install' | 'pull'; model?: string; pct: number | null; line: string; error: string | null; done: boolean } | null;
}

/** 정리 기록 한 줄 */
export interface CleanupLogView { id: number; at: string; project_id: string | null; project_name: string | null; team_id: string | null; team_name: string | null; kind: 'worktree' | 'branch'; target: string; branch: string | null; by: string; discarded: boolean; patch: boolean; patch_files: number; note: string | null }
/** 끝난 팀 목록(전체 보기) 한 줄 */
export interface FinishedTeamView { id: string; name: string; title: string; project_id: string | null; project_name: string | null; state: TeamState; finished_at: string | null; created_at: string; cost_usd: number; branch: string | null; worktree: boolean; patch: boolean; summary: string | null }

/** worktree·로컬 브랜치 정리(사이드바 버튼) */
export type CleanVerdict = 'remove' | 'ask' | 'keep';
export interface CleanItem { id: string; kind: 'worktree' | 'branch'; label: string; sub: string | null; verdict: CleanVerdict; why: string; dirty?: string[] }
export interface CleanScanView { project_id: string; project_name: string; base: string; items: CleanItem[] }
export interface GitCleanSummary { remove: number; ask: number; takenAt: string | null; running: boolean }

/** Claude 플랜 사용량: 한도 창별 사용 %(0~100) */
export interface UsageWindow { key: string; label: string; pct: number; resets_at: string | null }
export interface UsageView { available: boolean; plan: string | null; windows: UsageWindow[]; takenAt: string | null; error: string | null; login?: LoginInfo | null }
/** AI 계정. claude 는 계정마다 로그인 폴더(CLAUDE_CONFIG_DIR)를 따로 둔다. id 'default' = 이 맥의 기본 로그인(~/.claude) */
export type Provider = 'claude' | 'codex';
export interface AiAccount { id: string; provider: Provider; name: string; configDir: string | null; created_at: string }
export interface AiAccountView extends AiAccount { usage: UsageView | null; loginFlow: AuthLoginView; isDefault: boolean; usedBy: string[] }
/** claude auth status 요약 */
export interface LoginInfo { loggedIn: boolean; method: string | null; expiresAt: string | null; email: string | null; error?: string }
/** 화면에서 띄운 claude auth login 진행 */
export interface AuthLoginView { phase: 'idle' | 'waiting' | 'done' | 'failed'; url: string | null; output: string; startedAt: string | null; error: string | null }

/** PO 가 배운 것. skill = 절차(필요할 때 꺼내 씀), note = 늘 기억할 사실·선호 */
export interface KnowledgeView {
  id: string; kind: 'skill' | 'note'; name: string; when_to_use: string; body: string; source: string;
  uses: number; last_used_at: string | null; created_at: string; updated_at: string;
}

/** 등록된 저장소의 PR(열린 것 + 최근 3일 안에 닫히거나 병합된 것) */
export interface PrView {
  project_id: string; project_name: string; number: number; title: string; url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED'; draft: boolean; head: string; base: string; author: string;
  created_at: string; updated_at: string; merged_at: string | null;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null */
  review: string | null;
  checks: 'pass' | 'fail' | 'pending' | 'none';
  /** 검사(GitHub Actions 등) 하나하나 */
  check_list: { name: string; state: 'pass' | 'fail' | 'pending' | 'skip'; url: string | null }[];
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  /** CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | HAS_HOOKS | DRAFT | UNKNOWN */
  merge_state: string;
  /** 이 PR 을 만든 Hivelane 팀 */
  team_id: string | null;
}

/** 등록된 저장소(메인 폴더) 상태 */
export interface RepoView {
  project_id: string; project_name: string; path: string;
  branch: string | null; upstream: string | null;
  /** 연결된 원격 저장소(origin) · 없으면 이 맥에만 있는 저장소 */
  remote: { name: string; url: string; web: string | null; label: string } | null;
  /** 원격보다 앞선/뒤처진 커밋 수 */
  ahead: number; behind: number;
  /** 커밋 안 된 로컬 변경 파일 수 */
  dirty: number;
  /** 받으면 바뀌는 파일 수(원격에서 들어올 파일) */
  incoming: number;
  /** 받을 파일 중 로컬에서 고친 파일(겹치면 받기가 거절될 수 있음) */
  overlap: string[];
  fetched_at: string | null; error: string | null; pulling: boolean;
}

/** 스크립트 버튼 */
export interface ScriptRunView { id: number; script_id: string; command: string; cwd: string; started_at: string; finished_at: string | null; exit_code: number | null; by: 'local' | 'remote'; output?: string }
export interface ScriptView {
  id: string; project_id: string | null; project_name: string | null; name: string; command: string;
  /** 비우면 프로젝트 폴더(프로젝트 없으면 홈). 프로젝트 기준 상대 경로도 됨 */
  cwd: string;
  /** 실행 전 한 번 더 확인 */
  confirm: boolean;
  running_run_id: number | null;
  last_run: ScriptRunView | null;
}

export interface StateSnapshot {
  version: string;
  access: 'local' | 'remote';
  settings: Settings;
  resource: ResourceView;
  usage: UsageView;
  gitClean: GitCleanSummary;
  /** 끝난 팀 전체 수(스냅샷엔 최근 것만 실림) */
  finishedCount: { done: number; failed: number; archived: number };
  projects: Project[];
  templates: TeamTemplate[];
  teams: TeamView[];
  proposals: ProposalView[];
  poBusy: boolean;
  knowledgeCount: number;
  /** 내가 아직 안 본 PO 답변 수 */
  poUnread: number;
  prs: PrView[];
  repos: RepoView[];
  scripts: ScriptView[];
  prErrors: Record<string, string>;
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

/** 1인 팀: pm 외 역할이 없으면 PM 이 조사·수정·테스트·배포까지 혼자 한다. */
export function isSolo(roles: Pick<TemplateRole, 'key'>[]): boolean {
  return !roles.some((r) => r.key !== 'pm');
}
export const SOLO_TOOLS_LABEL = '모두(조사·수정·실행·커밋)';

export const TOOL_PRESET_LABEL: Record<ToolPreset, string> = {
  pm: '읽기·검색, 팀 지휘(delegate·ask·report)',
  write: '읽기·쓰기·Bash (커밋·푸시·운영 명령 차단)',
  verify: '읽기·Bash (검사 명령)',
  read: '읽기·검색만',
};
