import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  updateDaemonStatus,
  updateDaemonPid,
  getRunningTasks,
  failTask,
} from "../db/queries.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import type { Scheduler } from "./scheduler.js";

const log = createLogger("lifecycle");

/**
 * Write a PID file for this daemon process.
 */
export function writePidFile(daemonName: string): string {
  mkdirSync(config.pidDir, { recursive: true });
  const pidPath = resolve(config.pidDir, `${daemonName}.pid`);
  writeFileSync(pidPath, String(process.pid), "utf-8");
  log.debug("Wrote PID file", { path: pidPath, pid: process.pid });
  return pidPath;
}

/**
 * Remove the PID file for this daemon.
 */
export function removePidFile(daemonName: string): void {
  try {
    const pidPath = resolve(config.pidDir, `${daemonName}.pid`);
    unlinkSync(pidPath);
  } catch {
    // File may not exist
  }
}

/**
 * Register process signal handlers for graceful shutdown.
 */
export function registerShutdownHandlers(
  daemonId: string,
  daemonName: string,
  scheduler: Scheduler
): void {
  const shutdown = async (signal: string) => {
    log.info("Received signal, shutting down", { signal, daemonId });

    // Mark running tasks as failed
    const running = getRunningTasks(daemonId);
    for (const task of running) {
      failTask(task.id, `Daemon shutdown (${signal})`);
    }

    await scheduler.shutdown();
    updateDaemonStatus(daemonId, "idle");
    updateDaemonPid(daemonId, null);
    removePidFile(daemonName);
    log.info("Daemon shut down cleanly", { daemonId });
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", {
      error: err.message,
      stack: err.stack,
    });
    updateDaemonStatus(daemonId, "error");
    updateDaemonPid(daemonId, null);
    removePidFile(daemonName);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection", { reason: String(reason) });
  });
}
