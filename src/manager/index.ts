import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../db/index.js";
import {
  listDaemons,
  getIdleDaemonsWithWork,
  updateDaemonPid,
  updateDaemonTmuxSession,
  updateDaemonStatus,
  getDaemon,
  upsertCapability,
  getDueCronTriggers,
  markCronTriggerRun,
  disableCronTrigger,
  getOrCreateDaemon,
  getRootTask,
  createTask,
} from "../db/queries.js";
import { createLogger } from "../shared/logger.js";
import { getSkillManifest } from "../skills/library.js";
import { nextCronRun } from "../shared/cron.js";
import { DEFAULT_CAPABILITY_POLICIES } from "../capabilities/defaults.js";
import { config } from "../shared/config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const log = createLogger("manager");

/** Map of daemon name → child process */
const children = new Map<string, ChildProcess>();

/** How often to scan (ms) */
const SCAN_INTERVAL = 3000;

/** Stale heartbeat threshold — if updated_at is older than this, consider dead (ms) */
const STALE_THRESHOLD_MS = 30_000;
const CAPABILITY_SYNC_INTERVAL_MS = 60_000;
const TMUX_SESSION_PREFIX = "ow";
let lastCapabilitySyncAt = 0;
let tmuxAvailableCache: boolean | null = null;

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
  maybeSyncCapabilities();
  processDueCronTriggers();

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

    if (isProcessAlive(daemon.pid)) continue;

    const updatedAt = parseSqliteDate(daemon.updated_at);
    const age = Date.now() - updatedAt;
    const tmuxAlive = daemon.tmux_session
      ? tmuxSessionExists(daemon.tmux_session)
      : false;

    // For tmux-backed daemons, allow a grace window where session is up but daemon
    // hasn't written its PID heartbeat yet.
    if (age <= STALE_THRESHOLD_MS && (!daemon.pid || tmuxAlive)) {
      continue;
    }

    log.warn("Daemon process considered stale, respawning", {
      name: daemon.name,
      oldPid: daemon.pid,
      tmuxSession: daemon.tmux_session,
      tmuxAlive,
      staleSec: Math.round(age / 1000),
    });

    if (daemon.tmux_session) {
      killTmuxSession(daemon.tmux_session);
      updateDaemonTmuxSession(daemon.id, null);
    }
    updateDaemonPid(daemon.id, null);
    spawnDaemon(daemon.name, daemon.id, daemon.chat_id);
  }

  // 2.5. Reap idle daemons with stale runtime metadata
  for (const daemon of allDaemons) {
    if (daemon.status !== "idle") continue;

    const root = getRootTask(daemon.id);
    const hasActiveRoot =
      !!root &&
      (root.status === "pending" ||
        root.status === "blocked" ||
        root.status === "running");

    if (daemon.pid && !isProcessAlive(daemon.pid)) {
      log.info("Clearing stale PID for idle daemon", {
        name: daemon.name,
        pid: daemon.pid,
      });
      updateDaemonPid(daemon.id, null);
    }

    if (!daemon.tmux_session) continue;
    const tmuxAlive = tmuxSessionExists(daemon.tmux_session);
    if (!tmuxAlive) {
      log.info("Clearing stale tmux session for idle daemon", {
        name: daemon.name,
        session: daemon.tmux_session,
      });
      updateDaemonTmuxSession(daemon.id, null);
      continue;
    }

    if (!hasActiveRoot) {
      const anchorUpdatedAt = root?.updated_at ?? daemon.updated_at;
      const idleAgeMs = Date.now() - parseSqliteDate(anchorUpdatedAt);
      const withinGrace =
        config.idleReapGraceMs > 0 && idleAgeMs < config.idleReapGraceMs;
      if (withinGrace) {
        continue;
      }
      log.info("Reaping idle tmux daemon session with no active work", {
        name: daemon.name,
        session: daemon.tmux_session,
        idleAgeHours: Math.round(idleAgeMs / 1000 / 60 / 60),
        graceHours: Math.round(config.idleReapGraceMs / 1000 / 60 / 60),
      });
      killTmuxSession(daemon.tmux_session);
      updateDaemonTmuxSession(daemon.id, null);
      updateDaemonPid(daemon.id, null);
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

function maybeSyncCapabilities(): void {
  const now = Date.now();
  if (now - lastCapabilitySyncAt < CAPABILITY_SYNC_INTERVAL_MS) return;
  lastCapabilitySyncAt = now;

  for (const def of DEFAULT_CAPABILITY_POLICIES) {
    upsertCapability({
      id: def.id,
      name: def.name,
      description: def.description,
      defaultModel: def.defaultModel,
      defaultExecMode: def.defaultExecMode ?? "auto",
      defaultSkills: def.defaultSkills ?? [],
      allowedTools: def.allowedTools ?? [],
      allowedMcpServers: def.allowedMcpServers ?? [],
      maxTurns: def.maxTurns ?? null,
      timeoutMs: def.timeoutMs ?? null,
      rateLimitPerMin: def.rateLimitPerMin ?? null,
      budgetCapUsd: def.budgetCapUsd ?? null,
    });
  }

  const manifest = getSkillManifest();
  for (const skill of manifest) {
    upsertCapability({
      id: skill.name,
      name: skill.name,
      description: skill.description || `Capability powered by skill "${skill.name}"`,
      defaultExecMode: "auto",
      defaultSkills: [skill.name],
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Skill", "AskUserQuestion"],
      maxTurns: 50,
      timeoutMs: 600000,
      rateLimitPerMin: 20,
    });
  }
}

function processDueCronTriggers(): void {
  const now = new Date();
  const nowIso = now.toISOString().slice(0, 19).replace("T", " ");
  const due = getDueCronTriggers(nowIso);
  if (due.length === 0) return;

  for (const trigger of due) {
    const next = nextCronRun(trigger.cron_expr, now);
    if (!next) {
      log.warn("Disabling invalid cron trigger", {
        id: trigger.id,
        cronExpr: trigger.cron_expr,
      });
      disableCronTrigger(trigger.id);
      continue;
    }

    markCronTriggerRun(
      trigger.id,
      nowIso,
      next.toISOString().slice(0, 19).replace("T", " ")
    );

    const daemon = getOrCreateDaemon(trigger.daemon_name);
    const root = getRootTask(daemon.id);
    if (root && (root.status === "pending" || root.status === "blocked" || root.status === "running")) {
      log.info("Skipping cron trigger because daemon already has active root task", {
        triggerId: trigger.id,
        daemon: trigger.daemon_name,
        rootTask: root.id,
        status: root.status,
      });
      continue;
    }

    let skills: string[] = [];
    try {
      skills = JSON.parse(trigger.skills_override || "[]") as string[];
    } catch {
      skills = [];
    }

    createTask({
      daemonId: daemon.id,
      title: trigger.title,
      prompt: trigger.prompt,
      capabilityId: trigger.capability_id ?? undefined,
      agentModel: trigger.model_override ?? undefined,
      skills,
      idempotencyKey: `cron:${trigger.id}:${nowIso}`,
    });
    updateDaemonStatus(daemon.id, "idle");

    log.info("Scheduled trigger enqueued root task", {
      triggerId: trigger.id,
      daemon: trigger.daemon_name,
      title: trigger.title,
      capability: trigger.capability_id,
    });
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

  const workdir = resolve(config.workspacesDir, name);
  log.info("Spawning daemon process", { name, entry: jsEntry, workdir });

  const tmuxSession = buildTmuxSessionName(name, daemonId);
  const tmuxStarted = spawnDaemonInTmux({
    name,
    daemonId,
    chatId,
    entry: jsEntry,
    args,
    workdir,
    sessionName: tmuxSession,
  });
  if (tmuxStarted) {
    return;
  }
  updateDaemonTmuxSession(daemonId, null);

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
    updateDaemonTmuxSession(daemonId, null);
    log.info("Daemon spawned", { name, pid: child.pid });
  } else {
    log.error("Fork returned no PID", { name });
    updateDaemonStatus(daemonId, "error");
    updateDaemonPid(daemonId, null);
    updateDaemonTmuxSession(daemonId, null);
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
    updateDaemonTmuxSession(daemonId, null);
  });

  child.on("error", (err) => {
    log.error("Daemon process error", {
      name,
      error: err.message,
    });
    children.delete(name);
    // Issue #18: clear PID on error too
    updateDaemonPid(daemonId, null);
    updateDaemonTmuxSession(daemonId, null);
    updateDaemonStatus(daemonId, "error");
  });

  // Allow manager to exit independently of child
  child.unref();
  children.set(name, child);
}

function spawnDaemonInTmux(params: {
  name: string;
  daemonId: string;
  chatId: string | null;
  entry: string;
  args: string[];
  workdir: string;
  sessionName: string;
}): boolean {
  if (!hasTmuxBinary()) {
    log.warn("tmux not available, falling back to detached child process");
    return false;
  }

  const envMap = buildDaemonRuntimeEnv(
    params.name,
    params.daemonId,
    params.workdir
  );
  const envFilePath = writeDaemonRuntimeEnvFile(params.daemonId, envMap);

  if (tmuxSessionExists(params.sessionName)) {
    killTmuxSession(params.sessionName);
  }

  const daemonArgText = params.args.map(shellQuote).join(" ");
  const entryCmd = params.entry.endsWith(".ts")
    ? `exec npx tsx ${shellQuote(params.entry)} ${daemonArgText}`
    : `exec node ${shellQuote(params.entry)} ${daemonArgText}`;
  const shellCmd = [
    "set -a",
    `source ${shellQuote(envFilePath)}`,
    "set +a",
    `cd ${shellQuote(params.workdir)}`,
    entryCmd,
  ].join("; ");

  const result = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      params.sessionName,
      "-c",
      params.workdir,
      "zsh",
      "-lc",
      shellCmd,
    ],
    { stdio: "ignore", env: { ...process.env } }
  );

  if (result.status !== 0) {
    log.error("Failed to start daemon in tmux, falling back", {
      name: params.name,
      session: params.sessionName,
      code: result.status,
    });
    return false;
  }

  updateDaemonTmuxSession(params.daemonId, params.sessionName);
  updateDaemonPid(params.daemonId, null);
  updateDaemonStatus(params.daemonId, "running");
  log.info("Daemon spawned in tmux", {
    name: params.name,
    session: params.sessionName,
    envVars: Object.keys(envMap).length,
  });
  return true;
}

function hasTmuxBinary(): boolean {
  if (tmuxAvailableCache !== null) return tmuxAvailableCache;
  const result = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  tmuxAvailableCache = result.status === 0;
  return tmuxAvailableCache;
}

function tmuxSessionExists(sessionName: string): boolean {
  if (!hasTmuxBinary()) return false;
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function killTmuxSession(sessionName: string): void {
  if (!hasTmuxBinary()) return;
  spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
}

function buildTmuxSessionName(name: string, daemonId: string): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 24);
  return `${TMUX_SESSION_PREFIX}-${safeName}-${daemonId.slice(-6)}`;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function buildDaemonRuntimeEnv(
  daemonName: string,
  daemonId: string,
  workdir: string
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }

  const baseDir = resolve(config.workspacesDir, "..");
  const globalEnv = parseEnvFile(resolve(baseDir, "env", "global.env"));
  const workspaceEnv = parseEnvFile(resolve(workdir, ".daemon.env"));
  const secretEnv = parseEnvFile(resolve(baseDir, "secrets", `${daemonName}.env`));

  Object.assign(env, globalEnv, workspaceEnv, secretEnv, {
    OW_DAEMON_ID: daemonId,
    OW_DAEMON_NAME: daemonName,
    OW_DAEMON_WORKDIR: workdir,
  });
  absolutizePathEnvVars(env);
  return env;
}

function writeDaemonRuntimeEnvFile(
  daemonId: string,
  envMap: Record<string, string>
): string {
  const baseDir = resolve(config.workspacesDir, "..");
  const envDir = resolve(baseDir, "runtime", "env");
  mkdirSync(envDir, { recursive: true });
  const filePath = resolve(envDir, `${daemonId}.env`);

  const lines = Object.entries(envMap)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${shellQuote(value.replace(/\r?\n/g, "\\n"))}`);
  writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // ignore chmod failures on unsupported filesystems
  }
  return filePath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function absolutizePathEnvVars(env: Record<string, string>): void {
  const projectRoot = resolve(__dirname, "..", "..");
  const pathVars = [
    "OW_DB_PATH",
    "OW_LOG_DIR",
    "OW_PID_DIR",
    "OW_WORKSPACES_DIR",
    "OW_SKILL_LIBRARY_DIR",
    "OW_SKILLS_DIR",
  ];
  for (const key of pathVars) {
    const value = env[key];
    if (!value) continue;
    if (value.startsWith("/")) continue;
    env[key] = resolve(projectRoot, value);
  }
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
