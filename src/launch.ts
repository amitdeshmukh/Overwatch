import { fork, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createLogger } from "./shared/logger.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const log = createLogger("launch");

const children: Array<{ name: string; proc: ChildProcess }> = [];

function spawnComponent(name: string, entry: string, inheritStdio = false): ChildProcess {
  if (!existsSync(entry)) {
    log.error(`${name} entry point not found: ${entry}. Run npm run build first.`);
    process.exit(1);
  }

  const useTsx = entry.endsWith(".ts");
  const proc = useTsx
    ? spawn("npx", ["tsx", entry], {
        stdio: inheritStdio ? "inherit" : ["ignore", "ignore", "ignore"],
        env: { ...process.env },
        detached: false,
      })
    : fork(entry, [], {
        stdio: inheritStdio ? "inherit" : ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env },
      });

  proc.on("exit", (code, signal) => {
    log.info(`⚠️  ${name} exited`, { code, signal });

    // If a core component dies, restart it
    if (name !== "tui" && code !== 0 && !shuttingDown) {
      log.info(`🔄 Restarting ${name} in 3s...`);
      setTimeout(() => {
        if (!shuttingDown) {
          const idx = children.findIndex((c) => c.name === name);
          if (idx !== -1) children.splice(idx, 1);
          const newProc = spawnComponent(name, entry);
          children.push({ name, proc: newProc });
        }
      }, 3000);
    }
  });

  children.push({ name, proc });
  return proc;
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("🛑 Shutting down all components...");

  for (const { name, proc } of children) {
    if (!proc.killed) {
      log.info(`⏹️  Stopping ${name} (PID ${proc.pid})`);
      proc.kill("SIGTERM");
    }
  }

  // Force kill after 5s
  setTimeout(() => {
    for (const { proc } of children) {
      if (!proc.killed) proc.kill("SIGKILL");
    }
    process.exit(0);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Main ---

const isTsx = __dirname.endsWith("/src/") || __dirname.endsWith("/src");
const ext = isTsx ? ".ts" : ".js";
const managerEntry = resolve(__dirname, "manager", `index${ext}`);
const telegramEntry = resolve(__dirname, "telegram", `index${ext}`);
const tuiEntry = resolve(__dirname, "tui", `index${ext}`);
const webEntry = resolve(__dirname, "web", `index${ext}`);

const args = process.argv.slice(2);
const noTui = args.includes("--no-tui");
const noWeb = args.includes("--no-web");

log.info("🚀 Launching Overwatch...");

spawnComponent("manager", managerEntry);
spawnComponent("telegram", telegramEntry);

if (!noWeb) {
  spawnComponent("web", webEntry);
  log.info(`🌐 Web dashboard: http://localhost:${process.env.OW_WEB_PORT || 7777}`);
}

if (!noTui) {
  spawnComponent("tui", tuiEntry, true);
}

log.info("✅ All components launched. Press Ctrl+C to stop.");
