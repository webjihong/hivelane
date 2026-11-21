/** 순서대로 한 번씩만 실행되는 마이그레이션. 이미 적용된 항목은 고치지 말고 새 항목을 추가한다. */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  base_ref TEXT NOT NULL,
  deps_strategy TEXT NOT NULL DEFAULT 'symlink',
  heavy_patterns TEXT NOT NULL DEFAULT '[]',
  blocked_patterns TEXT NOT NULL DEFAULT '[]',
  memory_paths TEXT NOT NULL DEFAULT '[]',
  default_template_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE team_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  roles TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  template_id TEXT,
  budget_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  brief TEXT NOT NULL,
  template_id TEXT,
  roles TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  budget_usd REAL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  task_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  managed_by TEXT NOT NULL DEFAULT 'po',
  lifetime TEXT NOT NULL DEFAULT 'task',
  standing_brief TEXT NOT NULL DEFAULT '',
  check_command TEXT,
  check_interval_sec INTEGER,
  last_check_at TEXT,
  last_check_ok INTEGER,
  readable_team_ids TEXT NOT NULL DEFAULT '[]',
  worktree_path TEXT,
  branch TEXT,
  base_sha TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  stage INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  pause_kind TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'normal',
  question TEXT,
  nudges INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  budget_usd REAL,
  error TEXT,
  last_activity_at TEXT,
  last_heartbeat_at TEXT,
  revived_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX teams_state ON teams(state);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id),
  role_key TEXT NOT NULL,
  role_name TEXT NOT NULL,
  model TEXT NOT NULL,
  run_mode TEXT NOT NULL,
  parent_agent_id TEXT,
  session_id TEXT,
  state TEXT NOT NULL DEFAULT 'idle',
  current_step TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agents_team ON agents(team_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT, task_id TEXT, team_id TEXT,
  from_label TEXT NOT NULL,
  to_label TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_team ON messages(team_id, id);

CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  team_id TEXT,
  kind TEXT NOT NULL,
  name TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_events_agent ON agent_events(agent_id, id);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  team_id TEXT,
  tool_use_id TEXT,
  tool TEXT NOT NULL,
  command TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  waited_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX runs_team ON runs(team_id, id);
CREATE INDEX runs_tool_use ON runs(tool_use_id);

CREATE TABLE checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX checklist_team ON checklist(team_id, idx);

CREATE TABLE file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT, task_id TEXT, team_id TEXT NOT NULL,
  path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX file_changes_team ON file_changes(team_id);
CREATE INDEX file_changes_path ON file_changes(project_id, path);

CREATE TABLE work_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT, task_id TEXT, team_id TEXT, agent_id TEXT,
  stage TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX work_summaries_team ON work_summaries(team_id, id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  text,
  source_type UNINDEXED, source_id UNINDEXED, project_id UNINDEXED, task_id UNINDEXED, team_id UNINDEXED, created_at UNINDEXED,
  tokenize='trigram'
);

CREATE TABLE resource_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,
  cpu_pct REAL NOT NULL,
  mem_pct REAL NOT NULL,
  load_avg REAL NOT NULL,
  zone TEXT NOT NULL,
  per_team TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE po_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  team_id TEXT, task_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  handled_at TEXT
);
CREATE INDEX po_events_pending ON po_events(handled_at, id);

CREATE TABLE po_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX po_decisions_team ON po_decisions(team_id, id);

CREATE TABLE po_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  proposal_id TEXT,
  links TEXT,
  tone TEXT,
  team_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: 'fts_map',
    sql: `
CREATE TABLE fts_map (rowid INTEGER PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL, team_id TEXT);
CREATE INDEX fts_map_src ON fts_map(source_type, source_id);
CREATE INDEX fts_map_team ON fts_map(source_type, team_id);
INSERT INTO fts_map (rowid, source_type, source_id, team_id) SELECT rowid, source_type, source_id, team_id FROM search_fts;
CREATE INDEX agent_events_time ON agent_events(created_at);
CREATE INDEX runs_time ON runs(started_at);
CREATE INDEX po_events_time ON po_events(created_at);
`,
  },
  {
    id: 3,
    name: 'po_knowledge',
    sql: `
CREATE TABLE po_knowledge (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('skill','note')),
  name TEXT NOT NULL UNIQUE,
  when_to_use TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];
