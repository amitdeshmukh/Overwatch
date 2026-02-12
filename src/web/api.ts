import { getDb } from "../db/index.js";
import { listDaemons, getTasksByDaemon, getRecentEvents } from "../db/queries.js";

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
  totalCost: number;
  updatedAt: string;
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

export interface DashboardState {
  daemons: DashboardDaemon[];
  events: DashboardEvent[];
}

export function getDashboardState(): DashboardState {
  // Ensure DB is initialized
  getDb();

  const daemons = listDaemons().map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    pid: d.pid,
    totalCost: d.total_cost_usd,
    updatedAt: d.updated_at,
    agents: getTasksByDaemon(d.id).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agentRole: t.agent_role,
      agentModel: t.agent_model,
      skills: JSON.parse(t.skills || "[]") as string[],
      result: t.result,
      parentId: t.parent_id,
      createdAt: t.created_at,
    })),
  }));

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

  return {
    daemons,
    events: allEvents.slice(0, 50),
  };
}
