import {
  getOrCreateDaemon,
  createTask,
  updateDaemonStatus,
  insertCommand,
  getDaemonByName,
  getRootTask,
} from "../db/queries.js";
import { createLogger } from "../shared/logger.js";
import type { DaemonRow, CommandType } from "../shared/types.js";

const log = createLogger("router");

/**
 * Create a daemon and root task via DB.
 * The daemon manager will detect the new daemon and spawn the process.
 */
export function requestDaemonStart(
  name: string,
  description: string,
  chatId: string
): DaemonRow {
  const daemon = getOrCreateDaemon(name, chatId);

  // Only create a new root task if there isn't one already
  const existingRoot = getRootTask(daemon.id);
  if (!existingRoot) {
    createTask({
      daemonId: daemon.id,
      title: name,
      prompt: description,
    });
    log.info("Created root task", { name, daemonId: daemon.id });
  }

  // Set status to idle — daemon manager will detect pending work and spawn it
  updateDaemonStatus(daemon.id, "idle");

  return daemon;
}

/**
 * Send a command to a daemon via the commands table.
 */
export function sendCommand(
  daemonName: string,
  type: CommandType,
  payload?: Record<string, unknown>
): boolean {
  const daemon = getDaemonByName(daemonName);
  if (!daemon) return false;

  insertCommand({
    daemonId: daemon.id,
    type,
    payload,
  });

  log.info("Sent command", { daemon: daemonName, type });
  return true;
}

/**
 * Send a command to a daemon by daemon ID.
 */
export function sendCommandById(
  daemonId: string,
  type: CommandType,
  payload?: Record<string, unknown>
): void {
  insertCommand({ daemonId, type, payload });
}
