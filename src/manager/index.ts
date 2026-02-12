import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../db/index.js";
import {
  listDaemons,
  getIdleDaemonsWithWork,
  updateDaemonPid,
  updateDaemonStatus,
  getDaemon,
} from "../db/queries.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const log = createLogger("manager");

/** Map of daemon name → child process */
const children = new Map<string, ChildProcess>();

/** How often to scan (ms) */
const SCAN_INTERVAL = 3000;

/** Stale heartbeat threshold — if updated_at is older than this, consider dead (ms) */
const STALE_THRESHOLD_MS = 30_000;

async function main(): Promise<void> {
  getDb();
  log.info("Daemon manager started", { pid: process.pid });

  // Initial scan
  scan();

  // Start scan loop
  const timer = setInterval(() => {
    try {
      scan();
    } catch (err) {
      log.error("Scan error", { error: String(err) });
    }
  }, SCAN_INTERVAL);

  // Graceful shutdown — detach from children, don't kill them
  const shutdown = () => {
    log.info("Shutting down daemon manager");
    clearInterval(timer);

    for (const [name, child] of children) {
      child.unref();
      child.disconnect?.();
      log.info("Detached from daemon", { name, pid: child.pid });
    }

    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

function scan(): void {
  const allDaemons = listDaemons();

  // 1. Clean up children map for processes that exited
  for (const [name, child] of children) {
    if (child.exitCode !== null || child.killed) {
      log.info("Child process exited", {
        name,
        pid: child.pid,
        exitCode: child.exitCode,
      });
      children.delete(name);
    }
  }

  // 2. Find daemons marked running but with dead/missing processes
  for (const daemon of allDaemons) {
    if (daemon.status !== "running") continue;

    // Skip if we're already tracking this child
    if (children.has(daemon.name)) continue;

    if (!isProcessAlive(daemon.pid)) {
      // Check staleness — if the heartbeat is recent, give it a moment
      const updatedAt = parseSqliteDate(daemon.updated_at);
      const age = Date.now() - updatedAt;

      if (age > STALE_THRESHOLD_MS) {
        log.warn("Daemon process dead (stale heartbeat), respawning", {
          name: daemon.name,
          oldPid: daemon.pid,
          staleSec: Math.round(age / 1000),
        });
        // Clear the dead PID first to prevent re-detection loops
        updateDaemonPid(daemon.id, null);
        spawnDaemon(daemon.name, daemon.id, daemon.chat_id);
      } else {
        // Process dead but heartbeat recent — mark error, don't respawn yet
        log.warn("Daemon process dead but heartbeat recent, marking error", {
          name: daemon.name,
          pid: daemon.pid,
        });
        updateDaemonStatus(daemon.id, "error");
        updateDaemonPid(daemon.id, null);
      }
    }
  }

  // 3. Find idle daemons that have pending work
  const idleWithWork = getIdleDaemonsWithWork();
  for (const daemon of idleWithWork) {
    if (!children.has(daemon.name)) {
      log.info("Idle daemon has work, spawning", {
        name: daemon.name,
      });
      spawnDaemon(daemon.name, daemon.id, daemon.chat_id);
    }
  }
}

function spawnDaemon(
  name: string,
  daemonId: string,
  chatId: string | null
): void {
  // Resolve entry point — use .ts when running under tsx, .js when compiled
  const isTsx = __dirname.includes("/src/") || __dirname.endsWith("/src");
  const ext = isTsx ? ".ts" : ".js";
  const jsEntry = resolve(__dirname, "..", "daemon", `index${ext}`);

  if (!existsSync(jsEntry)) {
    log.error("Daemon entry point not found, is the project built?", {
      path: jsEntry,
    });
    updateDaemonStatus(daemonId, "error");
    return;
  }

  const args = ["--name", name];
  if (chatId) {
    args.push("--chat-id", chatId);
  }

  log.info("Spawning daemon process", { name, entry: jsEntry });

  let child: ChildProcess;
  try {
    child = jsEntry.endsWith(".ts")
      ? spawn("npx", ["tsx", jsEntry, ...args], {
          stdio: "ignore",
          env: { ...process.env },
          detached: true,
        })
      : fork(jsEntry, args, {
          stdio: "ignore",
          env: { ...process.env },
          detached: true,
        });
  } catch (err) {
    log.error("Failed to fork daemon process", {
      name,
      error: String(err),
    });
    updateDaemonStatus(daemonId, "error");
    updateDaemonPid(daemonId, null);
    return;
  }

  if (child.pid) {
    updateDaemonPid(daemonId, child.pid);
    updateDaemonStatus(daemonId, "running");
    log.info("Daemon spawned", { name, pid: child.pid });
  } else {
    log.error("Fork returned no PID", { name });
    updateDaemonStatus(daemonId, "error");
    updateDaemonPid(daemonId, null);
    return;
  }

  child.on("exit", (code, signal) => {
    log.info("Daemon process exited", { name, code, signal });
    children.delete(name);
    const d = getDaemon(daemonId);
    if (d && d.status === "running") {
      updateDaemonStatus(
        daemonId,
        code === 0 ? "idle" : "error"
      );
    }
    updateDaemonPid(daemonId, null);
  });

  child.on("error", (err) => {
    log.error("Daemon process error", {
      name,
      error: err.message,
    });
    children.delete(name);
    // Issue #18: clear PID on error too
    updateDaemonPid(daemonId, null);
    updateDaemonStatus(daemonId, "error");
  });

  // Allow manager to exit independently of child
  child.unref();
  children.set(name, child);
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse SQLite datetime string to epoch ms.
 * SQLite stores as "YYYY-MM-DD HH:MM:SS" (no timezone, assumed UTC).
 */
function parseSqliteDate(dateStr: string): number {
  // Append Z if not present to parse as UTC
  const normalized = dateStr.endsWith("Z") ? dateStr : dateStr + "Z";
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

main().catch((err) => {
  log.error("Daemon manager failed", { error: String(err) });
  closeDb();
  process.exit(1);
});
