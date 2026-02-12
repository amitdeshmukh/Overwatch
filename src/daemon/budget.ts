import { addDaemonCost, getDaemon } from "../db/queries.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("budget");

/**
 * Record cost from an agent result message and check budget.
 * Returns true if within budget, false if budget exceeded.
 */
export function recordCost(
  daemonId: string,
  costUsd: number
): boolean {
  if (costUsd > 0) {
    addDaemonCost(daemonId, costUsd);
    log.debug("Recorded cost", { daemonId, costUsd });
  }

  return !isBudgetExceeded(daemonId);
}

/**
 * Check if a daemon has exceeded its budget cap.
 */
export function isBudgetExceeded(daemonId: string): boolean {
  const cap = config.budgetCapUsd;
  if (cap <= 0) return false; // unlimited

  const daemon = getDaemon(daemonId);
  if (!daemon) return false;

  return daemon.total_cost_usd >= cap;
}
