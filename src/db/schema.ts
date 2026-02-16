import type Database from "better-sqlite3";
import { createLogger } from "../shared/logger.js";

const log = createLogger("schema");

/** Current schema version — bump when adding migrations */
export const SCHEMA_VERSION = 10;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS daemons (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  pid         INTEGER,
  status      TEXT NOT NULL DEFAULT 'idle',
  chat_id     TEXT,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  tmux_session TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  daemon_id   TEXT NOT NULL REFERENCES daemons(id),
  parent_id   TEXT REFERENCES tasks(id),
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  exec_mode   TEXT NOT NULL DEFAULT 'auto',
  agent_role  TEXT,
  capability_id TEXT REFERENCES capabilities(id),
  agent_model TEXT,
  agent_session_id TEXT,
  deps        TEXT DEFAULT '[]',
  skills      TEXT DEFAULT '[]',
  idempotency_key TEXT,
  result      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  daemon_id   TEXT NOT NULL REFERENCES daemons(id),
  task_id     TEXT REFERENCES tasks(id),
  type        TEXT NOT NULL,
  payload     TEXT DEFAULT '{}',
  notified    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  daemon_id   TEXT NOT NULL REFERENCES daemons(id),
  type        TEXT NOT NULL,
  payload     TEXT DEFAULT '{}',
  handled     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_configs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT,
  transport   TEXT NOT NULL,
  config      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,
  skill_path  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capabilities (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL DEFAULT '',
  default_model    TEXT,
  default_exec_mode TEXT NOT NULL DEFAULT 'auto',
  default_skills   TEXT NOT NULL DEFAULT '[]',
  allowed_tools    TEXT NOT NULL DEFAULT '[]',
  allowed_mcp_servers TEXT NOT NULL DEFAULT '[]',
  max_turns        INTEGER,
  timeout_ms       INTEGER,
  rate_limit_per_min INTEGER,
  budget_cap_usd   REAL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cron_triggers (
  id              TEXT PRIMARY KEY,
  daemon_name     TEXT NOT NULL,
  title           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  cron_expr       TEXT NOT NULL,
  capability_id   TEXT REFERENCES capabilities(id),
  model_override  TEXT,
  skills_override TEXT NOT NULL DEFAULT '[]',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  next_run_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capability_spend (
  capability_id   TEXT PRIMARY KEY REFERENCES capabilities(id),
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tg_question_threads (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  daemon_id            TEXT NOT NULL REFERENCES daemons(id),
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  chat_id              TEXT NOT NULL,
  question_message_id  INTEGER NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  daemon_id     TEXT NOT NULL REFERENCES daemons(id),
  task_id       TEXT REFERENCES tasks(id),
  parent_task_id TEXT REFERENCES tasks(id),
  source        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  event_subtype TEXT,
  payload       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decomposition_runs (
  id                TEXT PRIMARY KEY,
  daemon_id         TEXT NOT NULL REFERENCES daemons(id),
  task_id           TEXT REFERENCES tasks(id),
  status            TEXT NOT NULL DEFAULT 'running',
  model             TEXT NOT NULL,
  timeout_ms        INTEGER NOT NULL,
  max_turns         INTEGER NOT NULL,
  request_chars     INTEGER NOT NULL,
  prompt_chars      INTEGER NOT NULL,
  result_chars      INTEGER,
  parse_attempts    INTEGER NOT NULL DEFAULT 1,
  fallback_used     INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  technical_message TEXT,
  raw_result_excerpt TEXT,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT,
  elapsed_ms        INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL
);

-- Single-column indexes
CREATE INDEX IF NOT EXISTS idx_tasks_daemon ON tasks(daemon_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_events_daemon ON events(daemon_id);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_commands_daemon ON commands(daemon_id);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_tasks_daemon_status ON tasks(daemon_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_status ON tasks(parent_id, status);
CREATE INDEX IF NOT EXISTS idx_events_notified_type ON events(notified, type);
CREATE INDEX IF NOT EXISTS idx_commands_daemon_handled ON commands(daemon_id, handled);
CREATE INDEX IF NOT EXISTS idx_daemons_status ON daemons(status);
CREATE INDEX IF NOT EXISTS idx_tasks_capability ON tasks(capability_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_enabled ON capabilities(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_triggers_due ON cron_triggers(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_agent_traces_daemon ON agent_traces(daemon_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_traces_task ON agent_traces(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_decomposition_runs_daemon ON decomposition_runs(daemon_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_decomposition_runs_task ON decomposition_runs(task_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_question_msg ON tg_question_threads(chat_id, question_message_id);
`;

export function applySchema(db: Database.Database): void {
  // Check if schema_version table exists
  const hasVersion = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
    )
    .get();

  if (!hasVersion) {
    // Fresh install — apply full schema
    db.exec(SCHEMA_V1);
    db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(
      SCHEMA_VERSION
    );
    log.info("Applied fresh schema", { version: SCHEMA_VERSION });
    return;
  }

  const row = db
    .prepare(`SELECT version FROM schema_version LIMIT 1`)
    .get() as { version: number } | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    log.info("Migrating schema", { from: currentVersion, to: SCHEMA_VERSION });
    applyMigrations(db, currentVersion);
    db.prepare(`UPDATE schema_version SET version = ?`).run(SCHEMA_VERSION);
  }
}

function applyMigrations(
  db: Database.Database,
  fromVersion: number
): void {
  if (fromVersion < 2) {
    migrateToV2(db);
  }
  if (fromVersion < 3) {
    migrateToV3(db);
  }
  if (fromVersion < 4) {
    migrateToV4(db);
  }
  if (fromVersion < 5) {
    migrateToV5(db);
  }
  if (fromVersion < 6) {
    migrateToV6(db);
  }
  if (fromVersion < 7) {
    migrateToV7(db);
  }
  if (fromVersion < 8) {
    migrateToV8(db);
  }
  if (fromVersion < 9) {
    migrateToV9(db);
  }
  if (fromVersion < 10) {
    migrateToV10(db);
  }
}

function migrateToV2(db: Database.Database): void {
  log.info("Applying migration to v2");

  // Create commands table
  db.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      daemon_id TEXT NOT NULL REFERENCES daemons(id),
      type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      handled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Add columns safely — check if they exist first
  const daemonCols = getColumnNames(db, "daemons");
  if (!daemonCols.includes("chat_id")) {
    db.exec(`ALTER TABLE daemons ADD COLUMN chat_id TEXT`);
    log.info("Added daemons.chat_id column");
  }
  if (!daemonCols.includes("total_cost_usd")) {
    db.exec(
      `ALTER TABLE daemons ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0`
    );
    log.info("Added daemons.total_cost_usd column");
  }

  const eventCols = getColumnNames(db, "events");
  if (!eventCols.includes("notified")) {
    db.exec(
      `ALTER TABLE events ADD COLUMN notified INTEGER NOT NULL DEFAULT 0`
    );
    log.info("Added events.notified column");
  }

  // Create new indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_commands_daemon ON commands(daemon_id);
    CREATE INDEX IF NOT EXISTS idx_commands_daemon_handled ON commands(daemon_id, handled);
    CREATE INDEX IF NOT EXISTS idx_tasks_daemon_status ON tasks(daemon_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent_status ON tasks(parent_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_notified_type ON events(notified, type);
    CREATE INDEX IF NOT EXISTS idx_daemons_status ON daemons(status);
  `);

  log.info("Migration to v2 complete");
}

function migrateToV3(db: Database.Database): void {
  log.info("Applying migration to v3");

  const taskCols = getColumnNames(db, "tasks");
  if (!taskCols.includes("agent_model")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN agent_model TEXT`);
    log.info("Added tasks.agent_model column");
  }

  log.info("Migration to v3 complete");
}

function migrateToV4(db: Database.Database): void {
  log.info("Applying migration to v4");

  const taskCols = getColumnNames(db, "tasks");
  if (!taskCols.includes("skills")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN skills TEXT DEFAULT '[]'`);
    log.info("Added tasks.skills column");
  }

  log.info("Migration to v4 complete");
}

function migrateToV5(db: Database.Database): void {
  log.info("Applying migration to v5");

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_metadata (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      recent_tools TEXT NOT NULL DEFAULT '[]',
      question_hashes TEXT NOT NULL DEFAULT '[]',
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_metadata_task ON task_metadata(task_id)
  `);

  log.info("Migration to v5 complete");
}

function migrateToV6(db: Database.Database): void {
  log.info("Applying migration to v6");

  db.exec(`
    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      default_model TEXT,
      default_exec_mode TEXT NOT NULL DEFAULT 'auto',
      default_skills TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_triggers (
      id TEXT PRIMARY KEY,
      daemon_name TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      capability_id TEXT REFERENCES capabilities(id),
      model_override TEXT,
      skills_override TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const taskCols = getColumnNames(db, "tasks");
  if (!taskCols.includes("capability_id")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN capability_id TEXT REFERENCES capabilities(id)`);
    log.info("Added tasks.capability_id column");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_capability ON tasks(capability_id);
    CREATE INDEX IF NOT EXISTS idx_capabilities_enabled ON capabilities(enabled);
    CREATE INDEX IF NOT EXISTS idx_cron_triggers_due ON cron_triggers(enabled, next_run_at);
  `);

  log.info("Migration to v6 complete");
}

function migrateToV7(db: Database.Database): void {
  log.info("Applying migration to v7");

  const taskCols = getColumnNames(db, "tasks");
  if (!taskCols.includes("idempotency_key")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN idempotency_key TEXT`);
    log.info("Added tasks.idempotency_key column");
  }

  const capCols = getColumnNames(db, "capabilities");
  if (!capCols.includes("allowed_tools")) {
    db.exec(`ALTER TABLE capabilities ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!capCols.includes("allowed_mcp_servers")) {
    db.exec(`ALTER TABLE capabilities ADD COLUMN allowed_mcp_servers TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!capCols.includes("max_turns")) {
    db.exec(`ALTER TABLE capabilities ADD COLUMN max_turns INTEGER`);
  }
  if (!capCols.includes("timeout_ms")) {
    db.exec(`ALTER TABLE capabilities ADD COLUMN timeout_ms INTEGER`);
  }
  if (!capCols.includes("rate_limit_per_min")) {
    db.exec(`ALTER TABLE capabilities ADD COLUMN rate_limit_per_min INTEGER`);
  }
  if (!capCols.includes("budget_cap_usd")) {
    db.exec(`ALTER TABLE capabilities ADD COLUMN budget_cap_usd REAL`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_spend (
      capability_id TEXT PRIMARY KEY REFERENCES capabilities(id),
      total_cost_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
    ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL
  `);

  log.info("Migration to v7 complete");
}

function migrateToV8(db: Database.Database): void {
  log.info("Applying migration to v8");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_question_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      daemon_id TEXT NOT NULL REFERENCES daemons(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      chat_id TEXT NOT NULL,
      question_message_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_question_msg
    ON tg_question_threads(chat_id, question_message_id)
  `);

  log.info("Migration to v8 complete");
}

function migrateToV9(db: Database.Database): void {
  log.info("Applying migration to v9");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      daemon_id TEXT NOT NULL REFERENCES daemons(id),
      task_id TEXT REFERENCES tasks(id),
      parent_task_id TEXT REFERENCES tasks(id),
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_subtype TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_traces_daemon
    ON agent_traces(daemon_id, id DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_traces_task
    ON agent_traces(task_id, id DESC)
  `);

  log.info("Migration to v9 complete");
}

function migrateToV10(db: Database.Database): void {
  log.info("Applying migration to v10");

  db.exec(`
    CREATE TABLE IF NOT EXISTS decomposition_runs (
      id TEXT PRIMARY KEY,
      daemon_id TEXT NOT NULL REFERENCES daemons(id),
      task_id TEXT REFERENCES tasks(id),
      status TEXT NOT NULL DEFAULT 'running',
      model TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      max_turns INTEGER NOT NULL,
      request_chars INTEGER NOT NULL,
      prompt_chars INTEGER NOT NULL,
      result_chars INTEGER,
      parse_attempts INTEGER NOT NULL DEFAULT 1,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      technical_message TEXT,
      raw_result_excerpt TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      elapsed_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_decomposition_runs_daemon
    ON decomposition_runs(daemon_id, started_at DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_decomposition_runs_task
    ON decomposition_runs(task_id, started_at DESC)
  `);

  log.info("Migration to v10 complete");
}

function getColumnNames(
  db: Database.Database,
  table: string
): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}
