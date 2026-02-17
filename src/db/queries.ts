import { ulid } from "ulid";
import { getDb, inTransaction } from "./index.js";
import { createLogger } from "../shared/logger.js";
import type {
  DaemonRow,
  DaemonStatus,
  TaskRow,
  TaskStatus,
  ExecMode,
  AgentRole,
  EventRow,
  EventType,
  McpConfigRow,
  CommandRow,
  CommandType,
  AgentModel,
  CapabilityRow,
  CronTriggerRow,
  CapabilitySpendRow,
  TgQuestionThreadRow,
  AgentTraceRow,
  DecompositionRunRow,
  DecompositionRunStatus,
} from "../shared/types.js";

const log = createLogger("queries");

// --- Valid state transitions ---

const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["running", "blocked"],
  blocked: ["pending"],
  running: ["done", "failed"],
  done: [],
  failed: ["pending"],
};

// --- Daemons ---

export function createDaemon(name: string, chatId?: string): DaemonRow {
  const db = getDb();
  const id = ulid();
  db.prepare(
    `INSERT INTO daemons (id, name, status, chat_id) VALUES (?, ?, 'idle', ?)`
  ).run(id, name, chatId ?? null);
  return getDaemon(id)!;
}

/**
 * Get or create a daemon by name, avoiding race conditions.
 */
export function getOrCreateDaemon(
  name: string,
  chatId?: string
): DaemonRow {
  return inTransaction((db) => {
    const existing = db
      .prepare(`SELECT * FROM daemons WHERE name = ?`)
      .get(name) as DaemonRow | undefined;
    if (existing) {
      if (chatId && existing.chat_id !== chatId) {
        db.prepare(`UPDATE daemons SET chat_id = ? WHERE id = ?`).run(
          chatId,
          existing.id
        );
        return { ...existing, chat_id: chatId };
      }
      return existing;
    }
    const id = ulid();
    db.prepare(
      `INSERT INTO daemons (id, name, status, chat_id) VALUES (?, ?, 'idle', ?)`
    ).run(id, name, chatId ?? null);
    return db
      .prepare(`SELECT * FROM daemons WHERE id = ?`)
      .get(id) as DaemonRow;
  });
}

export function getDaemon(id: string): DaemonRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM daemons WHERE id = ?`)
    .get(id) as DaemonRow | undefined;
}

export function getDaemonByName(name: string): DaemonRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM daemons WHERE name = ?`)
    .get(name) as DaemonRow | undefined;
}

export function listDaemons(): DaemonRow[] {
  return getDb()
    .prepare(`SELECT * FROM daemons ORDER BY created_at DESC`)
    .all() as DaemonRow[];
}

export function deleteDaemon(id: string): void {
  inTransaction((db) => {
    db.prepare(`DELETE FROM decomposition_runs WHERE daemon_id = ?`).run(id);
    db.prepare(`DELETE FROM agent_traces WHERE daemon_id = ?`).run(id);
    db.prepare(`DELETE FROM tg_question_threads WHERE daemon_id = ?`).run(id);
    db.prepare(`DELETE FROM task_metadata WHERE task_id IN (SELECT id FROM tasks WHERE daemon_id = ?)`).run(id);
    db.prepare(`DELETE FROM commands WHERE daemon_id = ?`).run(id);
    db.prepare(`DELETE FROM events WHERE daemon_id = ?`).run(id);
    db.prepare(`DELETE FROM tasks WHERE daemon_id = ?`).run(id);
    db.prepare(`DELETE FROM daemons WHERE id = ?`).run(id);
  });
}

export function updateDaemonStatus(
  id: string,
  status: DaemonStatus
): void {
  getDb()
    .prepare(
      `UPDATE daemons SET status = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(status, id);
}

export function updateDaemonPid(
  id: string,
  pid: number | null
): void {
  getDb()
    .prepare(
      `UPDATE daemons SET pid = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(pid, id);
}

export function updateDaemonTmuxSession(
  id: string,
  session: string | null
): void {
  getDb()
    .prepare(
      `UPDATE daemons SET tmux_session = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(session, id);
}

export function updateDaemonHeartbeat(id: string): void {
  getDb()
    .prepare(
      `UPDATE daemons SET updated_at = datetime('now') WHERE id = ?`
    )
    .run(id);
}

export function addDaemonCost(id: string, costUsd: number): void {
  getDb()
    .prepare(
      `UPDATE daemons SET total_cost_usd = total_cost_usd + ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(costUsd, id);
}

/**
 * Find daemons with pending tasks that are idle (need to be started).
 */
export function getIdleDaemonsWithWork(): DaemonRow[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT d.* FROM daemons d
       JOIN tasks t ON t.daemon_id = d.id
       WHERE d.status = 'idle'
         AND t.status IN ('pending', 'blocked', 'running')
       ORDER BY d.created_at`
    )
    .all() as DaemonRow[];
}

// --- Tasks ---

export function createTask(params: {
  daemonId: string;
  parentId?: string;
  title: string;
  prompt: string;
  execMode?: ExecMode;
  agentRole?: AgentRole;
  capabilityId?: string;
  agentModel?: AgentModel;
  deps?: string[];
  skills?: string[];
  idempotencyKey?: string;
}): TaskRow {
  const db = getDb();
  const id = ulid();
  const deps = JSON.stringify(params.deps ?? []);
  const skills = JSON.stringify(params.skills ?? []);
  const status: TaskStatus =
    (params.deps?.length ?? 0) > 0 ? "blocked" : "pending";

  if (params.idempotencyKey) {
    const existing = db
      .prepare(`SELECT * FROM tasks WHERE idempotency_key = ?`)
      .get(params.idempotencyKey) as TaskRow | undefined;
    if (existing) return existing;
  }

  db.prepare(
    `INSERT INTO tasks (id, daemon_id, parent_id, title, prompt, status, exec_mode, agent_role, capability_id, agent_model, deps, skills, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.daemonId,
    params.parentId ?? null,
    params.title,
    params.prompt,
    status,
    params.execMode ?? "auto",
    params.agentRole ?? null,
    params.capabilityId ?? null,
    params.agentModel ?? null,
    deps,
    skills,
    params.idempotencyKey ?? null
  );

  return getTask(id)!;
}

/**
 * Create multiple tasks in a single transaction (used by decomposer).
 */
export function createTasksBatch(
  tasks: Array<{
    daemonId: string;
    parentId?: string;
    title: string;
    prompt: string;
    execMode?: ExecMode;
    agentRole?: AgentRole;
    capabilityId?: string;
    agentModel?: AgentModel;
    deps?: string[];
    skills?: string[];
    idempotencyKey?: string;
  }>
): TaskRow[] {
  return inTransaction((db) => {
    const results: TaskRow[] = [];
    const stmt = db.prepare(
      `INSERT INTO tasks (id, daemon_id, parent_id, title, prompt, status, exec_mode, agent_role, capability_id, agent_model, deps, skills, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const params of tasks) {
      const id = ulid();
      const deps = JSON.stringify(params.deps ?? []);
      const skills = JSON.stringify(params.skills ?? []);
      const status: TaskStatus =
        (params.deps?.length ?? 0) > 0 ? "blocked" : "pending";

      if (params.idempotencyKey) {
        const existing = db
          .prepare(`SELECT * FROM tasks WHERE idempotency_key = ?`)
          .get(params.idempotencyKey) as TaskRow | undefined;
        if (existing) {
          results.push(existing);
          continue;
        }
      }

      stmt.run(
        id,
        params.daemonId,
        params.parentId ?? null,
        params.title,
        params.prompt,
        status,
        params.execMode ?? "auto",
        params.agentRole ?? null,
        params.capabilityId ?? null,
        params.agentModel ?? null,
        deps,
        skills,
        params.idempotencyKey ?? null
      );

      results.push(
        db
          .prepare(`SELECT * FROM tasks WHERE id = ?`)
          .get(id) as TaskRow
      );
    }

    return results;
  });
}

/**
 * Update task deps and status in a batch transaction (used after decomposition).
 */
export function updateTaskDepsBatch(
  updates: Array<{ taskId: string; deps: string[]; status: TaskStatus }>
): void {
  inTransaction((db) => {
    const stmt = db.prepare(
      `UPDATE tasks SET deps = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    );
    for (const u of updates) {
      stmt.run(JSON.stringify(u.deps), u.status, u.taskId);
    }
  });
}

export function getTask(id: string): TaskRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .get(id) as TaskRow | undefined;
}

export function getTasksByDaemon(daemonId: string): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE daemon_id = ? ORDER BY created_at`
    )
    .all(daemonId) as TaskRow[];
}

export function getRootTask(daemonId: string): TaskRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE daemon_id = ? AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1`
    )
    .get(daemonId) as TaskRow | undefined;
}

export function getChildTasks(parentId: string): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at`
    )
    .all(parentId) as TaskRow[];
}

export function getPendingTasks(daemonId: string): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE daemon_id = ? AND status = 'pending' ORDER BY created_at`
    )
    .all(daemonId) as TaskRow[];
}

export function getRunningTasks(daemonId: string): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks WHERE daemon_id = ? AND status = 'running' ORDER BY created_at`
    )
    .all(daemonId) as TaskRow[];
}

/**
 * Update task status with transition validation.
 * Returns true if the update was applied, false if transition was invalid.
 */
export function updateTaskStatus(
  id: string,
  newStatus: TaskStatus
): boolean {
  const task = getTask(id);
  if (!task) {
    log.warn("updateTaskStatus: task not found", { id, newStatus });
    return false;
  }

  const allowed = VALID_TASK_TRANSITIONS[task.status];
  if (!allowed.includes(newStatus)) {
    log.warn("Invalid task status transition", {
      id,
      from: task.status,
      to: newStatus,
    });
    return false;
  }

  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(newStatus, id);
  return true;
}

export function updateTaskResult(id: string, result: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET result = ?, status = 'done', updated_at = datetime('now') WHERE id = ?`
    )
    .run(result, id);
}

export function updateTaskSessionId(
  id: string,
  sessionId: string
): void {
  getDb()
    .prepare(
      `UPDATE tasks SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(sessionId, id);
}

export function failTask(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(error, id);
}

export function resetTaskToPending(id: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'pending', result = NULL, agent_session_id = NULL, updated_at = datetime('now') WHERE id = ?`
    )
    .run(id);
}

/**
 * Check if all dependencies of a task are done.
 */
export function areDepsResolved(task: TaskRow): boolean {
  const deps: string[] = JSON.parse(task.deps);
  if (deps.length === 0) return true;

  const db = getDb();
  const placeholders = deps.map(() => "?").join(",");
  const count = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`
    )
    .get(...deps) as { cnt: number };

  return count.cnt === deps.length;
}

/**
 * Promote blocked tasks to pending if their deps are now resolved.
 */
export function promoteUnblockedTasks(daemonId: string): TaskRow[] {
  const db = getDb();
  const blocked = db
    .prepare(
      `SELECT * FROM tasks WHERE daemon_id = ? AND status = 'blocked'`
    )
    .all(daemonId) as TaskRow[];

  const promoted: TaskRow[] = [];
  for (const task of blocked) {
    if (areDepsResolved(task)) {
      db.prepare(
        `UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?`
      ).run(task.id);
      promoted.push({ ...task, status: "pending" });
    }
  }
  return promoted;
}

export function areChildrenDone(parentId: string): boolean {
  const children = getChildTasks(parentId);
  return (
    children.length > 0 && children.every((c) => c.status === "done")
  );
}

export function hasChildrenFailed(parentId: string): boolean {
  const children = getChildTasks(parentId);
  return children.some((c) => c.status === "failed");
}

// --- Events ---

export function insertEvent(params: {
  daemonId: string;
  taskId?: string;
  type: EventType;
  payload?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO events (daemon_id, task_id, type, payload) VALUES (?, ?, ?, ?)`
    )
    .run(
      params.daemonId,
      params.taskId ?? null,
      params.type,
      JSON.stringify(params.payload ?? {})
    );
}

export function getRecentEvents(
  daemonId: string,
  limit = 50
): EventRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM events WHERE daemon_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(daemonId, limit) as EventRow[];
}

// --- Agent traces (daemon + SDK stream) ---

export function insertAgentTrace(params: {
  daemonId: string;
  taskId?: string | null;
  parentTaskId?: string | null;
  source: "daemon" | "agent";
  eventType: string;
  eventSubtype?: string | null;
  payload?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO agent_traces (daemon_id, task_id, parent_task_id, source, event_type, event_subtype, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.daemonId,
      params.taskId ?? null,
      params.parentTaskId ?? null,
      params.source,
      params.eventType,
      params.eventSubtype ?? null,
      JSON.stringify(params.payload ?? {})
    );
}

export function getRecentAgentTraces(params: {
  daemonId: string;
  taskId?: string;
  limit?: number;
}): AgentTraceRow[] {
  const limit = params.limit ?? 200;
  if (params.taskId) {
    return getDb()
      .prepare(
        `SELECT * FROM agent_traces
         WHERE daemon_id = ? AND task_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(params.daemonId, params.taskId, limit) as AgentTraceRow[];
  }

  return getDb()
    .prepare(
      `SELECT * FROM agent_traces
       WHERE daemon_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(params.daemonId, limit) as AgentTraceRow[];
}

// --- Decomposition runs ---

export function startDecompositionRun(params: {
  daemonId: string;
  taskId?: string;
  model: string;
  timeoutMs: number;
  maxTurns: number;
  requestChars: number;
  promptChars: number;
}): string {
  const id = ulid();
  getDb()
    .prepare(
      `INSERT INTO decomposition_runs (
         id, daemon_id, task_id, status, model, timeout_ms, max_turns, request_chars, prompt_chars
       ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      params.daemonId,
      params.taskId ?? null,
      params.model,
      params.timeoutMs,
      params.maxTurns,
      params.requestChars,
      params.promptChars
    );
  return id;
}

export function finishDecompositionRun(params: {
  id: string;
  status: DecompositionRunStatus;
  elapsedMs: number;
  resultChars?: number | null;
  parseAttempts?: number;
  fallbackUsed?: boolean;
  errorCode?: string | null;
  technicalMessage?: string | null;
  rawResultExcerpt?: string | null;
}): void {
  getDb()
    .prepare(
      `UPDATE decomposition_runs
       SET status = ?,
           finished_at = datetime('now'),
           elapsed_ms = ?,
           result_chars = ?,
           parse_attempts = ?,
           fallback_used = ?,
           error_code = ?,
           technical_message = ?,
           raw_result_excerpt = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      params.status,
      params.elapsedMs,
      params.resultChars ?? null,
      params.parseAttempts ?? 1,
      params.fallbackUsed ? 1 : 0,
      params.errorCode ?? null,
      params.technicalMessage ?? null,
      params.rawResultExcerpt ?? null,
      params.id
    );
}

export function getRecentDecompositionRuns(params: {
  daemonId: string;
  taskId?: string;
  limit?: number;
}): DecompositionRunRow[] {
  const limit = params.limit ?? 20;
  if (params.taskId) {
    return getDb()
      .prepare(
        `SELECT * FROM decomposition_runs
         WHERE daemon_id = ? AND task_id = ?
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(params.daemonId, params.taskId, limit) as DecompositionRunRow[];
  }

  return getDb()
    .prepare(
      `SELECT * FROM decomposition_runs
       WHERE daemon_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(params.daemonId, limit) as DecompositionRunRow[];
}

/**
 * Atomically fetch and mark unnotified events.
 * Returns the events that were marked. Prevents duplicate notifications.
 */
export function claimUnnotifiedEvents(
  limit = 100
): EventRow[] {
  return inTransaction((db) => {
    const events = db
      .prepare(
        `SELECT * FROM events
         WHERE notified = 0
           AND type IN ('task_done', 'task_failed', 'needs_input')
         ORDER BY id
         LIMIT ?`
      )
      .all(limit) as EventRow[];

    if (events.length > 0) {
      const ids = events.map((e) => e.id);
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(
        `UPDATE events SET notified = 1 WHERE id IN (${placeholders})`
      ).run(...ids);
    }

    return events;
  });
}

// --- Commands (bot → daemon communication) ---

export function insertCommand(params: {
  daemonId: string;
  type: CommandType;
  payload?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO commands (daemon_id, type, payload) VALUES (?, ?, ?)`
    )
    .run(
      params.daemonId,
      params.type,
      JSON.stringify(params.payload ?? {})
    );
}

export function getPendingCommands(
  daemonId: string
): CommandRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM commands WHERE daemon_id = ? AND handled = 0 ORDER BY id`
    )
    .all(daemonId) as CommandRow[];
}

export function markCommandHandled(id: number): void {
  getDb()
    .prepare(`UPDATE commands SET handled = 1 WHERE id = ?`)
    .run(id);
}

// --- MCP Configs ---

export function getMcpConfigsForRole(
  role: AgentRole
): McpConfigRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM mcp_configs WHERE role IS NULL OR role = ?`
    )
    .all(role) as McpConfigRow[];
}

export function listMcpConfigs(): McpConfigRow[] {
  return getDb()
    .prepare(`SELECT * FROM mcp_configs ORDER BY name`)
    .all() as McpConfigRow[];
}

export function upsertMcpConfig(params: {
  name: string;
  role?: AgentRole;
  transport: "stdio" | "http";
  config: Record<string, unknown>;
}): void {
  const db = getDb();
  const id = ulid();
  db.prepare(
    `INSERT INTO mcp_configs (id, name, role, transport, config)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config`
  ).run(
    id,
    params.name,
    params.role ?? null,
    params.transport,
    JSON.stringify(params.config)
  );
}

export function deleteMcpConfig(name: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM mcp_configs WHERE name = ?`)
    .run(name);
  return result.changes > 0;
}

// --- Task Metadata (for loop detection & question deduplication) ---

/**
 * Initialize task metadata on first agent spawn
 */
export function initializeTaskMetadata(taskId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO task_metadata (task_id, recent_tools, question_hashes, turn_count)
     VALUES (?, '[]', '[]', 0)`
  ).run(taskId);
}

/**
 * Update recent tool usage for loop detection
 * Keeps only the last 10 tools
 */
export function recordToolUsage(taskId: string, toolName: string): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT recent_tools FROM task_metadata WHERE task_id = ?`)
    .get(taskId) as { recent_tools: string } | undefined;

  if (!row) {
    initializeTaskMetadata(taskId);
    recordToolUsage(taskId, toolName);
    return;
  }

  const tools: string[] = JSON.parse(row.recent_tools);
  tools.push(toolName);
  if (tools.length > 10) {
    tools.shift();
  }

  db.prepare(
    `UPDATE task_metadata SET recent_tools = ?, updated_at = datetime('now') WHERE task_id = ?`
  ).run(JSON.stringify(tools), taskId);
}

/**
 * Check if a question hash was already asked
 */
export function isQuestionAsked(
  taskId: string,
  questionHash: string
): boolean {
  const row = getDb()
    .prepare(`SELECT question_hashes FROM task_metadata WHERE task_id = ?`)
    .get(taskId) as { question_hashes: string } | undefined;

  if (!row) return false;

  const hashes: string[] = JSON.parse(row.question_hashes);
  return hashes.includes(questionHash);
}

/**
 * Record a question hash
 */
export function recordQuestionHash(
  taskId: string,
  questionHash: string
): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT question_hashes FROM task_metadata WHERE task_id = ?`)
    .get(taskId) as { question_hashes: string } | undefined;

  if (!row) {
    initializeTaskMetadata(taskId);
    recordQuestionHash(taskId, questionHash);
    return;
  }

  const hashes: string[] = JSON.parse(row.question_hashes);
  if (!hashes.includes(questionHash)) {
    hashes.push(questionHash);
  }

  db.prepare(
    `UPDATE task_metadata SET question_hashes = ?, updated_at = datetime('now') WHERE task_id = ?`
  ).run(JSON.stringify(hashes), taskId);
}

/**
 * Increment turn counter
 */
export function incrementTaskTurnCount(taskId: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT turn_count FROM task_metadata WHERE task_id = ?`)
    .get(taskId) as { turn_count: number } | undefined;

  const newCount = (row?.turn_count ?? 0) + 1;

  db.prepare(
    `UPDATE task_metadata SET turn_count = ?, updated_at = datetime('now') WHERE task_id = ?`
  ).run(newCount, taskId);

  return newCount;
}

/**
 * Get task depth by counting parent chain
 */
export function getTaskDepth(taskId: string): number {
  const task = getTask(taskId);
  if (!task || !task.parent_id) return 0;

  return 1 + getTaskDepth(task.parent_id);
}

// --- Capabilities ---

export function upsertCapability(params: {
  id: string;
  name: string;
  description: string;
  defaultModel?: AgentModel | null;
  defaultExecMode?: ExecMode;
  defaultSkills?: string[];
  allowedTools?: string[];
  allowedMcpServers?: string[];
  maxTurns?: number | null;
  timeoutMs?: number | null;
  rateLimitPerMin?: number | null;
  budgetCapUsd?: number | null;
  enabled?: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT INTO capabilities (id, name, description, default_model, default_exec_mode, default_skills, allowed_tools, allowed_mcp_servers, max_turns, timeout_ms, rate_limit_per_min, budget_cap_usd, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         default_model = excluded.default_model,
         default_exec_mode = excluded.default_exec_mode,
         default_skills = excluded.default_skills,
         allowed_tools = excluded.allowed_tools,
         allowed_mcp_servers = excluded.allowed_mcp_servers,
         max_turns = excluded.max_turns,
         timeout_ms = excluded.timeout_ms,
         rate_limit_per_min = excluded.rate_limit_per_min,
         budget_cap_usd = excluded.budget_cap_usd,
         enabled = excluded.enabled,
         updated_at = datetime('now')`
    )
    .run(
      params.id,
      params.name,
      params.description,
      params.defaultModel ?? null,
      params.defaultExecMode ?? "auto",
      JSON.stringify(params.defaultSkills ?? []),
      JSON.stringify(params.allowedTools ?? []),
      JSON.stringify(params.allowedMcpServers ?? []),
      params.maxTurns ?? null,
      params.timeoutMs ?? null,
      params.rateLimitPerMin ?? null,
      params.budgetCapUsd ?? null,
      params.enabled === false ? 0 : 1
    );
}

export function getCapability(id: string): CapabilityRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM capabilities WHERE id = ?`)
    .get(id) as CapabilityRow | undefined;
}

export function listCapabilities(enabledOnly = true): CapabilityRow[] {
  const db = getDb();
  if (enabledOnly) {
    return db
      .prepare(`SELECT * FROM capabilities WHERE enabled = 1 ORDER BY name`)
      .all() as CapabilityRow[];
  }
  return db
    .prepare(`SELECT * FROM capabilities ORDER BY name`)
    .all() as CapabilityRow[];
}

// --- Cron Triggers ---

export function createCronTrigger(params: {
  daemonName: string;
  chatId?: string;
  title: string;
  prompt: string;
  cronExpr: string;
  capabilityId?: string;
  modelOverride?: AgentModel;
  skillsOverride?: string[];
  nextRunAt: string;
  enabled?: boolean;
}): CronTriggerRow {
  const db = getDb();
  const id = ulid();
  db.prepare(
    `INSERT INTO cron_triggers (id, daemon_name, chat_id, title, prompt, cron_expr, capability_id, model_override, skills_override, enabled, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.daemonName,
    params.chatId ?? null,
    params.title,
    params.prompt,
    params.cronExpr,
    params.capabilityId ?? null,
    params.modelOverride ?? null,
    JSON.stringify(params.skillsOverride ?? []),
    params.enabled === false ? 0 : 1,
    params.nextRunAt
  );
  return getCronTrigger(id)!;
}

export function getCronTrigger(id: string): CronTriggerRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM cron_triggers WHERE id = ?`)
    .get(id) as CronTriggerRow | undefined;
}

export function listCronTriggers(enabledOnly = false): CronTriggerRow[] {
  const db = getDb();
  if (enabledOnly) {
    return db
      .prepare(`SELECT * FROM cron_triggers WHERE enabled = 1 ORDER BY next_run_at`)
      .all() as CronTriggerRow[];
  }
  return db
    .prepare(`SELECT * FROM cron_triggers ORDER BY next_run_at`)
    .all() as CronTriggerRow[];
}

export function getDueCronTriggers(now: string): CronTriggerRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM cron_triggers
       WHERE enabled = 1 AND next_run_at <= ?
       ORDER BY next_run_at ASC`
    )
    .all(now) as CronTriggerRow[];
}

export function markCronTriggerRun(
  id: string,
  lastRunAt: string,
  nextRunAt: string
): void {
  getDb()
    .prepare(
      `UPDATE cron_triggers
       SET last_run_at = ?, next_run_at = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(lastRunAt, nextRunAt, id);
}

export function disableCronTrigger(id: string): void {
  getDb()
    .prepare(
      `UPDATE cron_triggers
       SET enabled = 0, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(id);
}

export function addCapabilityCost(
  capabilityId: string,
  costUsd: number
): void {
  if (costUsd <= 0) return;
  getDb()
    .prepare(
      `INSERT INTO capability_spend (capability_id, total_cost_usd)
       VALUES (?, ?)
       ON CONFLICT(capability_id) DO UPDATE SET
         total_cost_usd = capability_spend.total_cost_usd + excluded.total_cost_usd,
         updated_at = datetime('now')`
    )
    .run(capabilityId, costUsd);
}

export function getCapabilitySpend(
  capabilityId: string
): CapabilitySpendRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM capability_spend WHERE capability_id = ?`)
    .get(capabilityId) as CapabilitySpendRow | undefined;
}

// --- Telegram question threads ---

export function upsertTelegramQuestionThread(params: {
  daemonId: string;
  taskId: string;
  chatId: string;
  questionMessageId: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO tg_question_threads (daemon_id, task_id, chat_id, question_message_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, question_message_id) DO UPDATE SET
         daemon_id = excluded.daemon_id,
         task_id = excluded.task_id`
    )
    .run(
      params.daemonId,
      params.taskId,
      params.chatId,
      params.questionMessageId
    );
}

export function getTelegramQuestionThread(
  chatId: string,
  questionMessageId: number
): TgQuestionThreadRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM tg_question_threads
       WHERE chat_id = ? AND question_message_id = ?`
    )
    .get(chatId, questionMessageId) as TgQuestionThreadRow | undefined;
}

export function getLatestTelegramThreadForTask(
  chatId: string,
  taskId: string
): TgQuestionThreadRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM tg_question_threads
       WHERE chat_id = ? AND task_id = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(chatId, taskId) as TgQuestionThreadRow | undefined;
}
