import type { Context } from "grammy";
import {
  listDaemons,
  getDaemonByName,
  getTasksByDaemon,
  getTask,
  getChildTasks,
  getRootTask,
  listMcpConfigs,
  deleteMcpConfig,
  deleteDaemon,
  insertCommand,
} from "../db/queries.js";
import { requestDaemonStart, sendCommand } from "./router.js";
import { createLogger } from "../shared/logger.js";
import type { TaskRow, TaskStatus } from "../shared/types.js";

const log = createLogger("commands");

/** Telegram message byte limit */
const TG_MAX_BYTES = 4096;

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "[ ]",
  blocked: "[~]",
  running: "[*]",
  done: "[+]",
  failed: "[x]",
};

/**
 * Truncate text to fit within Telegram's 4096-byte limit.
 */
function safeTruncate(text: string, maxBytes = TG_MAX_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;

  // Binary search for the right character cutoff
  const suffix = "\n...(truncated)";
  const suffixBytes = encoder.encode(suffix).length;
  const target = maxBytes - suffixBytes;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (encoder.encode(text.slice(0, mid)).length <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + suffix;
}

/**
 * Wrap a command handler with error handling.
 */
function safe(
  handler: (ctx: Context) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      log.error("Command handler error", { error: String(err) });
      try {
        await ctx.reply(`Error: ${String(err)}`);
      } catch {
        // Can't even reply — give up
      }
    }
  };
}

export const handleStart = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const parts = text.replace("/start", "").trim();

  if (!parts) {
    await ctx.reply(
      "Usage: /start <project-name> <description>\nExample: /start api Build a REST API with auth"
    );
    return;
  }

  const [name, ...descParts] = parts.split(" ");
  const description = descParts.join(" ") || name;
  const chatId = String(ctx.chat?.id ?? "");

  const daemon = requestDaemonStart(name, description, chatId);
  await ctx.reply(
    `Started project "${name}" (daemon: ${daemon.id})\nThe daemon manager will spawn the process shortly.`
  );
});

export const handleStatus = safe(async (ctx) => {
  const daemons = listDaemons();

  if (daemons.length === 0) {
    await ctx.reply("No daemons.");
    return;
  }

  const lines = daemons.map((d) => {
    const tasks = getTasksByDaemon(d.id);
    const done = tasks.filter((t) => t.status === "done").length;
    const total = tasks.length;
    const icon =
      d.status === "running"
        ? "*"
        : d.status === "idle"
          ? "o"
          : "!";
    const cost =
      d.total_cost_usd > 0
        ? ` $${d.total_cost_usd.toFixed(2)}`
        : "";
    const pid = d.pid ? ` [PID ${d.pid}]` : "";
    return `${icon} ${d.name} (${d.status})${pid} — ${done}/${total} tasks${cost}`;
  });

  await ctx.reply(safeTruncate(`Daemons:\n${lines.join("\n")}`));
});

export const handleTree = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const name = text.replace("/tree", "").trim();

  if (!name) {
    await ctx.reply("Usage: /tree <daemon-name>");
    return;
  }

  const daemon = getDaemonByName(name);
  if (!daemon) {
    await ctx.reply(`Daemon "${name}" not found.`);
    return;
  }

  const root = getRootTask(daemon.id);
  if (!root) {
    await ctx.reply(`No tasks for "${name}".`);
    return;
  }

  const tree = renderTree(root, 0);
  await ctx.reply(
    safeTruncate(`Task tree for "${name}":\n\n${tree}`)
  );
});

function renderTree(task: TaskRow, depth: number): string {
  const indent = "  ".repeat(depth);
  const icon = STATUS_ICONS[task.status as TaskStatus] ?? "[ ]";
  let line = `${indent}${icon} ${task.title}`;

  if (task.agent_role) {
    const model = task.agent_model ? `/${task.agent_model}` : "";
    line += ` (${task.agent_role}${model})`;
  }

  const children = getChildTasks(task.id);
  const childLines = children.map((c) => renderTree(c, depth + 1));

  return [line, ...childLines].join("\n");
}

export const handleKill = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const name = text.replace("/kill", "").trim();

  if (!name) {
    await ctx.reply("Usage: /kill <daemon-name>");
    return;
  }

  const daemon = getDaemonByName(name);
  if (!daemon) {
    await ctx.reply(`Daemon "${name}" not found.`);
    return;
  }

  // If the daemon has a live process, send a kill command
  if (daemon.pid && isProcessAlive(daemon.pid)) {
    sendCommand(name, "kill");
    await ctx.reply(`Kill command sent to "${name}".`);
  } else {
    // Dead/error daemon — remove directly from DB
    deleteDaemon(daemon.id);
    await ctx.reply(`Removed dead daemon "${name}".`);
  }
});

export const handlePause = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const name = text.replace("/pause", "").trim();

  if (!name) {
    await ctx.reply("Usage: /pause <daemon-name>");
    return;
  }

  const sent = sendCommand(name, "pause");
  if (sent) {
    await ctx.reply(`Pause command sent to "${name}".`);
  } else {
    await ctx.reply(`Daemon "${name}" not found.`);
  }
});

export const handleResume = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const name = text.replace("/resume", "").trim();

  if (!name) {
    await ctx.reply("Usage: /resume <daemon-name>");
    return;
  }

  const daemon = getDaemonByName(name);
  if (!daemon) {
    await ctx.reply(`Daemon "${name}" not found.`);
    return;
  }

  if (!daemon.pid || !isProcessAlive(daemon.pid)) {
    const chatId = String(ctx.chat?.id ?? "");
    requestDaemonStart(name, "", chatId);
    await ctx.reply(
      `Daemon "${name}" was dead. Re-requesting spawn from daemon manager.`
    );
    return;
  }

  sendCommand(name, "resume");
  await ctx.reply(`Resume command sent to "${name}".`);
});

export const handleRetry = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const taskId = text.replace("/retry", "").trim();

  if (!taskId) {
    await ctx.reply("Usage: /retry <task-id>");
    return;
  }

  const task = getTask(taskId);
  if (!task) {
    await ctx.reply(`Task "${taskId}" not found.`);
    return;
  }

  if (task.status !== "failed") {
    await ctx.reply(
      `Task "${task.title}" is ${task.status}, not failed.`
    );
    return;
  }

  insertCommand({
    daemonId: task.daemon_id,
    type: "retry",
    payload: { taskId },
  });

  await ctx.reply(`Retry command sent for "${task.title}".`);
});

export const handleLogs = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const taskId = text.replace("/logs", "").trim();

  if (!taskId) {
    await ctx.reply("Usage: /logs <task-id>");
    return;
  }

  const task = getTask(taskId);
  if (!task) {
    await ctx.reply(`Task "${taskId}" not found.`);
    return;
  }

  const result = task.result ?? "(no output yet)";
  const header = `Logs for "${task.title}" [${task.status}]:\n\n`;
  await ctx.reply(safeTruncate(header + result));
});

export const handleAnswer = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const match = text
    .replace("/answer", "")
    .trim()
    .match(/^(\S+)\s+(.+)$/s);

  if (!match) {
    await ctx.reply("Usage: /answer <task-id> <response text>");
    return;
  }

  const [, taskId, response] = match;
  const task = getTask(taskId);
  if (!task) {
    await ctx.reply(`Task "${taskId}" not found.`);
    return;
  }

  insertCommand({
    daemonId: task.daemon_id,
    type: "answer",
    payload: { taskId, text: response },
  });

  await ctx.reply(`Answer sent for "${task.title}".`);
});

export const handleConfig = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const args = text.replace("/config", "").trim();

  if (!args) {
    const configs = listMcpConfigs();
    if (configs.length === 0) {
      await ctx.reply("No MCP configs. Use /config add <name> <json>");
      return;
    }
    const lines = configs.map(
      (c) =>
        `${c.name} (${c.transport})${c.role ? ` [${c.role}]` : ""}`
    );
    await ctx.reply(`MCP Configs:\n${lines.join("\n")}`);
    return;
  }

  const parts = args.split(" ");
  const action = parts[0];

  if (action === "rm" && parts[1]) {
    const deleted = deleteMcpConfig(parts[1]);
    await ctx.reply(
      deleted
        ? `Deleted "${parts[1]}".`
        : `"${parts[1]}" not found.`
    );
    return;
  }

  await ctx.reply(
    "Usage:\n/config — list configs\n/config rm <name> — delete config"
  );
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
