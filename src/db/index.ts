import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../shared/config.js";
import { applySchema } from "./schema.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = config.dbPath;
  mkdirSync(dirname(dbPath), { recursive: true });

  log.info("Opening database", { path: dbPath });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");

  applySchema(_db);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}

/**
 * Run a function inside a SQLite transaction.
 * Automatically commits on success, rolls back on error.
 */
export function inTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  const txn = db.transaction(() => fn(db));
  return txn();
}
