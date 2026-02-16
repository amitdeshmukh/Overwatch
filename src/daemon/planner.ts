import { decompose } from "./decomposer.js";
import { createLogger } from "../shared/logger.js";
import type { TaskPlan } from "../shared/types.js";

const log = createLogger("planner");

/**
 * Planner: turns a root request into an execution plan (task graph).
 * Executor/scheduler consumes this plan and handles lifecycle and retries.
 */
export async function planRootTask(
  userRequest: string,
  workdir: string,
  context?: {
    daemonId?: string;
    taskId?: string;
  }
): Promise<TaskPlan> {
  const tasks = await decompose(userRequest, workdir, context);
  log.info("Planner produced task graph", { taskCount: tasks.length });
  return { tasks };
}
