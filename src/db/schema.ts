import type Database from "better-sqlite3";
import { createLogger } from "../shared/logger.js";

const log = createLogger("schema");

/** Current schema version — bump when adding migrations */
export const SCHEMA_VERSION = 5;

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
  agent_model TEXT,
  agent_session_id TEXT,
  deps        TEXT DEFAULT '[]',
  skills      TEXT DEFAULT '[]',
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

function getColumnNames(
  db: Database.Database,
  table: string
): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}
