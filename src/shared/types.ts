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
  | "file_changed";

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

// --- Runtime types ---

export interface DecomposedTask {
  title: string;
  prompt: string;
  exec_mode: ExecMode;
  role: AgentRole;
  model: AgentModel;
  deps: string[]; // titles of tasks this depends on
  skills: string[]; // skill names from skill library
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
}
