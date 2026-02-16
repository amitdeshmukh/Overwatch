// --- Database row types ---

export type DaemonStatus = "running" | "idle" | "error";
export type TaskStatus = "pending" | "blocked" | "running" | "done" | "failed";
export type ExecMode = "auto" | "hybrid";
export type McpTransport = "stdio" | "http";
export type CommandType = "answer" | "kill" | "pause" | "resume" | "retry";
export type AgentModel = "haiku" | "sonnet" | "opus";

export type AgentRole =
  | "lead"
  | "backend-dev"
  | "frontend-dev"
  | "reviewer"
  | "researcher"
  | "db-admin"
  | "tester";

export interface DaemonRow {
  id: string;
  name: string;
  pid: number | null;
  status: DaemonStatus;
  chat_id: string | null;
  total_cost_usd: number;
  tmux_session: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  daemon_id: string;
  parent_id: string | null;
  title: string;
  prompt: string;
  status: TaskStatus;
  exec_mode: ExecMode;
  agent_role: AgentRole | null;
  capability_id: string | null;
  agent_model: AgentModel | null;
  agent_session_id: string | null;
  deps: string; // JSON array of task IDs
  skills: string; // JSON array of skill names
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  daemon_id: string;
  task_id: string | null;
  type: EventType;
  payload: string; // JSON
  notified: number;
  created_at: string;
}

export type EventType =
  | "task_started"
  | "task_done"
  | "task_failed"
  | "needs_input"
  | "agent_stop"
  | "file_changed"
  | "loop_detected"
  | "duplicate_question"
  | "depth_limit_exceeded";

export interface CommandRow {
  id: number;
  daemon_id: string;
  type: CommandType;
  payload: string; // JSON
  handled: number;
  created_at: string;
}

export interface McpConfigRow {
  id: string;
  name: string;
  role: string | null;
  transport: McpTransport;
  config: string; // JSON
  created_at: string;
}

export interface SkillRow {
  id: string;
  role: AgentRole;
  skill_path: string;
  created_at: string;
}

export interface CapabilityRow {
  id: string;
  name: string;
  description: string;
  default_model: AgentModel | null;
  default_exec_mode: ExecMode;
  default_skills: string; // JSON array of skill names
  allowed_tools: string; // JSON array of Claude Agent SDK tool names
  allowed_mcp_servers: string; // JSON array of MCP server names
  max_turns: number | null;
  timeout_ms: number | null;
  rate_limit_per_min: number | null;
  budget_cap_usd: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CronTriggerRow {
  id: string;
  daemon_name: string;
  title: string;
  prompt: string;
  cron_expr: string;
  capability_id: string | null;
  model_override: AgentModel | null;
  skills_override: string; // JSON array
  enabled: number;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export interface CapabilitySpendRow {
  capability_id: string;
  total_cost_usd: number;
  updated_at: string;
}

export interface TgQuestionThreadRow {
  id: number;
  daemon_id: string;
  task_id: string;
  chat_id: string;
  question_message_id: number;
  created_at: string;
}

export interface AgentTraceRow {
  id: number;
  daemon_id: string;
  task_id: string | null;
  parent_task_id: string | null;
  source: string;
  event_type: string;
  event_subtype: string | null;
  payload: string;
  created_at: string;
}

export type DecompositionRunStatus = "running" | "success" | "failed";

export interface DecompositionRunRow {
  id: string;
  daemon_id: string;
  task_id: string | null;
  status: DecompositionRunStatus;
  model: string;
  timeout_ms: number;
  max_turns: number;
  request_chars: number;
  prompt_chars: number;
  result_chars: number | null;
  parse_attempts: number;
  fallback_used: number;
  error_code: string | null;
  technical_message: string | null;
  raw_result_excerpt: string | null;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
  created_at: string;
  updated_at: string;
}

// --- Runtime types ---

export interface DecomposedTask {
  title: string;
  prompt: string;
  exec_mode: ExecMode;
  model: AgentModel;
  deps: string[]; // titles of tasks this depends on
  skills: string[]; // skill names from skill library
  capability_id?: string;
}

export interface TaskPlan {
  tasks: DecomposedTask[];
}

export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpMcpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpConfig | HttpMcpConfig;

export interface AgentHandle {
  taskId: string;
  sessionId: string | null;
  abortController: AbortController;
  promise: Promise<string>;
}

export interface DaemonContext {
  daemonId: string;
  daemonName: string;
  chatId: string | null;
  workdir: string;
  taskDepths?: Map<string, number>; // taskId -> depth
}

// --- TaskResult: canonical schema for all agent ↔ daemon communication ---

/**
 * Every agent result and every inter-component message MUST conform to this schema.
 * Sub-agents return a single TaskResult.
 * Parent aggregation produces a TaskResultAggregate.
 */
export interface TaskResult {
  status: "success" | "error";
  message: string;
  data?: Record<string, unknown>;  // skill-specific metadata
}

export interface TaskResultEntry {
  title: string;
  result: TaskResult;
}

/** Aggregated result when parent collects child results */
export type TaskResultAggregate = TaskResultEntry[];

/**
 * Try to extract a JSON object or array from a string that may contain
 * surrounding text (e.g. markdown fences, explanation before/after JSON).
 * Returns the parsed value or null.
 */
function extractJSON(raw: string): unknown {
  const trimmed = raw.trim();

  // 1. Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // 2. Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue
    }
  }

  // 3. Find first { or [ and match to closing bracket
  const start = trimmed.search(/[{\[]/);
  if (start === -1) return null;

  const opener = trimmed[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) depth--;
    if (depth === 0) {
      try {
        return JSON.parse(trimmed.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Validate and parse a raw string into a TaskResult.
 * Handles agent output that may contain text around the JSON.
 */
export function parseTaskResult(raw: string): TaskResult | null {
  const obj = extractJSON(raw);
  if (!isTaskResult(obj)) return null;
  return obj;
}

/**
 * Validate and parse a raw string into a TaskResultAggregate.
 * Handles agent output that may contain text around the JSON.
 */
export function parseTaskResultAggregate(raw: string): TaskResultAggregate | null {
  const arr = extractJSON(raw);
  if (!Array.isArray(arr)) return null;
  for (const entry of arr) {
    if (typeof entry !== "object" || !entry) return null;
    if (typeof entry.title !== "string") return null;
    if (!isTaskResult(entry.result)) return null;
  }
  return arr as TaskResultAggregate;
}

/**
 * Type guard: is this object a valid TaskResult?
 */
export function isTaskResult(obj: unknown): obj is TaskResult {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o.status !== "success" && o.status !== "error") return false;
  if (typeof o.message !== "string") return false;
  return true;
}
