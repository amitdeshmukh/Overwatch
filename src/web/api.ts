import { getDb } from "../db/index.js";
import {
  listDaemons,
  getTasksByDaemon,
  getRecentEvents,
  listCronTriggers,
  getRecentAgentTraces,
  getRecentDecompositionRuns,
} from "../db/queries.js";

export interface DashboardAgent {
  id: string;
  title: string;
  status: string;
  agentRole: string | null;
  agentModel: string | null;
  skills: string[];
  result: string | null;
  parentId: string | null;
  createdAt: string;
}

export interface DashboardDaemon {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  tmuxSession: string | null;
  isReaped: boolean;
  totalCost: number;
  updatedAt: string;
  latestDecomposition: DashboardDecompositionRun | null;
  agents: DashboardAgent[];
}

export interface DashboardEvent {
  id: number;
  daemonId: string;
  taskId: string | null;
  type: string;
  payload: string;
  createdAt: string;
}

export interface DashboardCronTrigger {
  id: string;
  daemonName: string;
  title: string;
  cronExpr: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
}

export interface DashboardTrace {
  id: number;
  daemonId: string;
  taskId: string | null;
  parentTaskId: string | null;
  source: string;
  eventType: string;
  eventSubtype: string | null;
  payload: string;
  createdAt: string;
}

export interface DashboardDecompositionRun {
  id: string;
  taskId: string | null;
  status: string;
  model: string;
  timeoutMs: number;
  maxTurns: number;
  requestChars: number;
  promptChars: number;
  resultChars: number | null;
  parseAttempts: number;
  fallbackUsed: boolean;
  errorCode: string | null;
  technicalMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
}

export interface DashboardState {
  daemons: DashboardDaemon[];
  events: DashboardEvent[];
  cronTriggers: DashboardCronTrigger[];
  traces: DashboardTrace[];
}

export function getDashboardState(): DashboardState {
  // Ensure DB is initialized
  getDb();

  const daemons = listDaemons().map((d) => {
    const latest = getRecentDecompositionRuns({ daemonId: d.id, limit: 1 })[0];
    const agents = getTasksByDaemon(d.id).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agentRole: t.agent_role,
      agentModel: t.agent_model,
      skills: JSON.parse(t.skills || "[]") as string[],
      result: t.result,
      parentId: t.parent_id,
      createdAt: t.created_at,
    }));
    const hasActiveWork = agents.some(
      (a) => a.status === "pending" || a.status === "blocked" || a.status === "running"
    );
    const isReaped =
      d.status === "idle" &&
      d.pid === null &&
      d.tmux_session === null &&
      !hasActiveWork &&
      agents.length > 0;
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      pid: d.pid,
      tmuxSession: d.tmux_session,
      isReaped,
      totalCost: d.total_cost_usd,
      updatedAt: d.updated_at,
      latestDecomposition: latest
        ? {
            id: latest.id,
            taskId: latest.task_id,
            status: latest.status,
            model: latest.model,
            timeoutMs: latest.timeout_ms,
            maxTurns: latest.max_turns,
            requestChars: latest.request_chars,
            promptChars: latest.prompt_chars,
            resultChars: latest.result_chars,
            parseAttempts: latest.parse_attempts,
            fallbackUsed: latest.fallback_used === 1,
            errorCode: latest.error_code,
            technicalMessage: latest.technical_message,
            startedAt: latest.started_at,
            finishedAt: latest.finished_at,
            elapsedMs: latest.elapsed_ms,
          }
        : null,
      agents,
    };
  });

  // Collect recent events across all daemons
  const allEvents: DashboardEvent[] = [];
  for (const d of daemons) {
    const events = getRecentEvents(d.id, 20);
    for (const e of events) {
      allEvents.push({
        id: e.id,
        daemonId: e.daemon_id,
        taskId: e.task_id,
        type: e.type,
        payload: e.payload,
        createdAt: e.created_at,
      });
    }
  }

  // Sort by id descending (most recent first), take top 50
  allEvents.sort((a, b) => b.id - a.id);

  const cronTriggers = listCronTriggers(false).map((t) => ({
    id: t.id,
    daemonName: t.daemon_name,
    title: t.title,
    cronExpr: t.cron_expr,
    enabled: t.enabled === 1,
    nextRunAt: t.next_run_at,
    lastRunAt: t.last_run_at,
  }));

  const traces: DashboardTrace[] = [];
  for (const d of daemons) {
    const daemonTraces = getRecentAgentTraces({ daemonId: d.id, limit: 120 });
    for (const tr of daemonTraces) {
      traces.push({
        id: tr.id,
        daemonId: tr.daemon_id,
        taskId: tr.task_id,
        parentTaskId: tr.parent_task_id,
        source: tr.source,
        eventType: tr.event_type,
        eventSubtype: tr.event_subtype,
        payload: tr.payload,
        createdAt: tr.created_at,
      });
    }
  }
  traces.sort((a, b) => b.id - a.id);

  return {
    daemons,
    events: allEvents.slice(0, 50),
    cronTriggers,
    traces: traces.slice(0, 500),
  };
}
