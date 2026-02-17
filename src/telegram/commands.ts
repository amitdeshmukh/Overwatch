import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "grammy";
import {
  listDaemons,
  getDaemonByName,
  getTasksByDaemon,
  getTask,
  getDaemon,
  getChildTasks,
  getRootTask,
  listMcpConfigs,
  deleteMcpConfig,
  deleteDaemon,
  insertCommand,
  listCapabilities,
  createCronTrigger,
  listCronTriggers,
  getTelegramQuestionThread,
  upsertTelegramQuestionThread,
  resetTaskToPending,
  updateDaemonStatus,
  createTask,
} from "../db/queries.js";
import { requestDaemonStart, sendCommand, sendCommandById } from "./router.js";
import { createLogger } from "../shared/logger.js";
import type { TaskRow, TaskStatus } from "../shared/types.js";
import { nextCronRun } from "../shared/cron.js";

const log = createLogger("commands");

/** Telegram message byte limit */
const TG_MAX_BYTES = 4096;

/**
 * Escape special characters for Telegram MarkdownV2 format.
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/**
 * Extract images and text content from result.
 * Supports:
 * - Markdown image syntax: ![alt](url)
 * - Direct URLs (http://, https://)
 * - File paths (./path/to/image.png, /absolute/path/image.jpg)
 */
function extractContent(
  text: string
): { textContent: string; images: Array<{ url: string; isFile: boolean }> } {
  const images: Array<{ url: string; isFile: boolean }> = [];
  let textContent = text;

  // Extract markdown image syntax: ![alt](url or path)
  const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = mdImageRegex.exec(text)) !== null) {
    const imagePath = match[2];
    if (imagePath && !images.some((img) => img.url === imagePath)) {
      const isFile = isLocalImageFile(imagePath);
      images.push({ url: imagePath, isFile });
    }
  }

  // Remove markdown image syntax from text
  textContent = textContent.replace(mdImageRegex, "");

  // Extract standalone image URLs (http/https)
  const urlRegex =
    /(https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|bmp))/gi;
  while ((match = urlRegex.exec(text)) !== null) {
    const imageUrl = match[1];
    if (imageUrl && !images.some((img) => img.url === imageUrl)) {
      images.push({ url: imageUrl, isFile: false });
    }
  }

  // Remove standalone image URLs from text
  textContent = textContent.replace(urlRegex, "").trim();

  // Extract file paths (./path or /absolute/path)
  const filePathRegex = /(?:^|\s)(\.\/[^\s]+|\/[^\s]+)\.(?:png|jpg|jpeg|gif|webp|bmp)(?:\s|$)/gm;
  while ((match = filePathRegex.exec(text)) !== null) {
    const filePath = match[1];
    if (filePath && !images.some((img) => img.url === filePath)) {
      if (isLocalImageFile(filePath)) {
        images.push({ url: filePath, isFile: true });
      }
    }
  }

  // Remove file paths from text
  textContent = textContent.replace(filePathRegex, " ").trim();

  return { textContent, images };
}

/**
 * Check if a path is a valid local image file.
 */
function isLocalImageFile(filePath: string): boolean {
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return false;
  }
  try {
    const fullPath = resolve(filePath);
    return existsSync(fullPath);
  } catch {
    return false;
  }
}

/**
 * Use Claude to summarize verbose output for Telegram (concise, ~300 chars max).
 */
async function formatForTelegram(text: string): Promise<string> {
  if (!text.trim()) return "";

  // For short text, just return as-is
  if (text.length < 200) return text;

  try {
    // Use Claude to intelligently summarize
    for await (const message of query({
      prompt: `Summarize this in 2-3 sentences for Telegram (max 300 chars). Be concise, skip fluff:\n\n${text}`,
      options: {
        model: "claude-opus-4-6",
      },
    })) {
      if (message.type === "result" && "result" in message) {
        const summary = (message as { result: string }).result;
        return summary || text.substring(0, 300);
      }
    }
  } catch (err) {
    log.warn("Failed to summarize with Claude", { error: String(err) });
  }

  // Fallback: extract first paragraph
  const firstPara = text.split(/\n\n+/)[0];
  return firstPara.substring(0, 300);
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminatePid(pid: number): Promise<"terminated" | "not_found" | "failed"> {
  if (!isProcessAlive(pid)) return "not_found";

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return "failed";
  }

  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (!isProcessAlive(pid)) return "terminated";
  }

  // Escalate if still running
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return isProcessAlive(pid) ? "failed" : "terminated";
  }

  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if (!isProcessAlive(pid)) return "terminated";
  }

  return "failed";
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
  const root = getRootTask(daemon.id);
  const sourceMessageId = ctx.message?.message_id;
  if (root && sourceMessageId) {
    upsertTelegramQuestionThread({
      daemonId: daemon.id,
      taskId: root.id,
      chatId,
      questionMessageId: sourceMessageId,
    });
  }
  await ctx.reply(
    `Started project "${name}" (daemon: ${daemon.id})\nThe daemon manager will spawn the process shortly.`
  );
});

export const handleStatus = safe(async (ctx) => {
  const daemons = listDaemons();

  if (daemons.length === 0) {
    await ctx.reply("No daemons\\.");
    return;
  }

  const lines = daemons.map((d) => {
    const tasks = getTasksByDaemon(d.id);
    const done = tasks.filter((t) => t.status === "done").length;
    const total = tasks.length;
    const icon =
      d.status === "running"
        ? "▶"
        : d.status === "idle"
          ? "⏸"
          : "⚠";
    const cost =
      d.total_cost_usd > 0
        ? ` \\($${escapeMarkdownV2(d.total_cost_usd.toFixed(2))}\\)`
        : "";
    const pid = d.pid ? ` \\[PID ${d.pid}\\]` : "";
    return `${icon} *${escapeMarkdownV2(d.name)}* \\(${d.status}\\)${pid} — ${done}/${total} tasks${cost}`;
  });

  await ctx.reply(safeTruncate(`*Daemons:*\n${lines.join("\n")}`), {
    parse_mode: "MarkdownV2",
  });
});

export const handleTree = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const name = text.replace("/tree", "").trim();

  if (!name) {
    await ctx.reply("Usage: /tree <daemon\\-name>");
    return;
  }

  const daemon = getDaemonByName(name);
  if (!daemon) {
    await ctx.reply(`Daemon "${name}" not found\\.`);
    return;
  }

  const root = getRootTask(daemon.id);
  if (!root) {
    await ctx.reply(`No tasks for "${name}"\\.`);
    return;
  }

  const tree = renderTree(root, 0);
  await ctx.reply(
    safeTruncate(`*Task tree for "${escapeMarkdownV2(name)}":*\n\n${tree}`),
    { parse_mode: "MarkdownV2" }
  );
});

function renderTree(task: TaskRow, depth: number): string {
  const indent = "  ".repeat(depth);
  // Use better symbols for Telegram
  const statusSymbols: Record<TaskStatus, string> = {
    pending: "⭕",
    blocked: "🔒",
    running: "▶️",
    done: "✅",
    failed: "❌",
  };
  const icon = statusSymbols[task.status as TaskStatus] ?? "⭕";
  let line = `${indent}${icon} *${task.title.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, "\\$&")}*`;

  if (task.agent_model) {
    line += ` \\(${task.agent_model}\\)`;
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

  if (daemon.pid) {
    const result = await terminatePid(daemon.pid);
    if (result === "failed") {
      await ctx.reply(`Failed to terminate "${name}" (PID ${daemon.pid}).`);
      return;
    }
  }

  deleteDaemon(daemon.id);
  await ctx.reply(`Killed and removed "${name}".`);
});

export const handleKillAll = safe(async (ctx) => {
  const daemons = listDaemons();

  if (daemons.length === 0) {
    await ctx.reply("No daemons to kill.");
    return;
  }

  const results: string[] = [];
  for (const daemon of daemons) {
    if (daemon.pid) {
      const result = await terminatePid(daemon.pid);
      if (result === "failed") {
        results.push(`${daemon.name}: failed to terminate PID ${daemon.pid}`);
        continue;
      }
    }
    deleteDaemon(daemon.id);
    results.push(`${daemon.name}: killed and removed`);
  }

  const killedCount = results.filter((r) => r.includes("killed and removed")).length;
  await ctx.reply(`Killed ${killedCount}/${daemons.length} daemon(s):\n${results.join("\n")}`);
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
  let { textContent, images } = extractContent(result);

  // Also search daemon's workspace for any image files
  try {
    const workspacePath = resolve(".overwatch/workspaces", task.daemon_id);
    if (existsSync(workspacePath)) {
      const files = readdirSync(workspacePath, { recursive: true });
      for (const file of files) {
        if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(String(file))) {
          const imagePath = join(workspacePath, String(file));
          if (!images.some((img) => img.url === imagePath)) {
            images.push({ url: imagePath, isFile: true });
          }
        }
      }
    }
  } catch (err) {
    log.warn("Failed to search workspace for images", { error: String(err) });
  }

  const formatted = await formatForTelegram(textContent);
  const header = `*Logs for "${escapeMarkdownV2(task.title)}" \\[${task.status}\\]*`;

  // Send header + text
  await ctx.reply(safeTruncate(header + "\n\n" + escapeMarkdownV2(formatted)), {
    parse_mode: "MarkdownV2",
  });

  // Send images if found
  for (const image of images) {
    try {
      if (image.isFile) {
        // Send local file as buffer
        const filePath = resolve(image.url);
        const fileBuffer = readFileSync(filePath);
        await ctx.replyWithPhoto(fileBuffer as unknown as string);
      } else {
        // Send from URL
        await ctx.replyWithPhoto(image.url);
      }
    } catch (err) {
      log.warn("Failed to send image", { path: image.url, error: String(err) });
      await ctx.reply(`Image: ${image.url}`);
    }
  }
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

  if (task.status !== "running") {
    const daemon = getDaemon(task.daemon_id);
    if (!daemon) {
      await ctx.reply(`Daemon for task "${task.title}" no longer exists.`);
      return;
    }
    const followup = enqueueFollowupTask(daemon.id, task.id, task.title, task.result, response);
    updateDaemonStatus(daemon.id, "idle");
    await ctx.reply(
      `Task "${task.title}" is ${task.status}. Started follow-up task "${followup.title}" in daemon "${daemon.name}".`
    );
    return;
  }

  insertCommand({
    daemonId: task.daemon_id,
    type: "answer",
    payload: { taskId, text: response },
  });

  await ctx.reply(`Answer sent for "${task.title}".`);
});

function enqueueFollowupTask(
  daemonId: string,
  parentTaskId: string,
  parentTitle: string,
  parentResult: string | null,
  userText: string
): TaskRow {
  const priorResult = parentResult ? parentResult.slice(0, 3000) : "(no prior result captured)";
  const prompt = [
    `User sent a follow-up on completed task "${parentTitle}".`,
    "",
    "Previous task result/context:",
    priorResult,
    "",
    "Follow-up request from user:",
    userText,
    "",
    "Continue from the current workspace state and provide the requested outcome.",
  ].join("\n");

  return createTask({
    daemonId,
    parentId: parentTaskId,
    title: "Follow-up from user",
    prompt,
  });
}

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

export const handleCapabilities = safe(async (ctx) => {
  const capabilities = listCapabilities(true);
  if (capabilities.length === 0) {
    await ctx.reply("No capabilities registered yet.");
    return;
  }

  const lines = capabilities.map((c) => {
    const model = c.default_model ? ` model=${c.default_model}` : "";
    const skills = (() => {
      try {
        const parsed = JSON.parse(c.default_skills) as string[];
        return parsed.length > 0 ? ` skills=${parsed.join(",")}` : "";
      } catch {
        return "";
      }
    })();
    return `- ${c.id}${model}${skills}`;
  });

  await ctx.reply(`Capabilities:\n${lines.join("\n")}`);
});

export const handleSchedule = safe(async (ctx) => {
  const text = ctx.message?.text ?? "";
  const args = text.replace("/schedule", "").trim();

  if (!args) {
    await ctx.reply(
      "Usage:\n/schedule <daemon> <cron> <capability-or-> | <title> | <prompt> [| skill1,skill2] [| model]\nExample:\n/schedule growth \"0 14 * * 1\" market-research | Weekly trends | Analyze ad performance and suggest 3 tests"
    );
    return;
  }

  const match = args.match(/^(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s*(.*)$/s);
  if (!match) {
    await ctx.reply("Usage: /schedule <daemon> <cron> <capability-or-> | <title> | <prompt> [| skills] [| model]");
    return;
  }

  const daemonName = match[1];
  const cronExpr = match[2];
  const capabilityToken = match[3];
  const remainder = match[4].trim();

  const next = nextCronRun(cronExpr, new Date());
  if (!next) {
    await ctx.reply("Invalid cron expression. Supported tokens: *, */N, N, and comma lists.");
    return;
  }

  const parts = remainder.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    await ctx.reply("Provide title and prompt after capability using '|': <title> | <prompt> [| skills] [| model]");
    return;
  }

  const title = parts[0];
  const prompt = parts[1];
  const skills = parts[2]
    ? parts[2].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const modelRaw = parts[3]?.toLowerCase();
  const model = modelRaw === "haiku" || modelRaw === "sonnet" || modelRaw === "opus"
    ? modelRaw
    : undefined;

  const capabilityId = capabilityToken === "-" ? undefined : capabilityToken;

  const trigger = createCronTrigger({
    daemonName,
    chatId: String(ctx.chat?.id ?? ""),
    title,
    prompt,
    cronExpr,
    capabilityId,
    skillsOverride: skills,
    modelOverride: model,
    nextRunAt: next.toISOString().slice(0, 19).replace("T", " "),
    enabled: true,
  });

  await ctx.reply(
    `Scheduled trigger ${trigger.id}\nDaemon: ${daemonName}\nCron (UTC): ${cronExpr}\nNext run: ${trigger.next_run_at}\nCapability: ${capabilityId ?? "general"}`
  );
});

export const handleSchedules = safe(async (ctx) => {
  const triggers = listCronTriggers(false).slice(0, 20);
  if (triggers.length === 0) {
    await ctx.reply("No schedules configured.");
    return;
  }

  const lines = triggers.map((t) => {
    const state = t.enabled ? "active" : "paused";
    return `${t.id} [${state}] ${t.daemon_name} @ ${t.cron_expr} -> ${t.title} (next ${t.next_run_at})`;
  });

  await ctx.reply(safeTruncate(`Schedules:\n${lines.join("\n")}`));
});

type ManagerIntent =
  | { action: "chat"; message: string }
  | { action: "start_daemon"; name: string; prompt: string }
  | {
      action: "daemon_command";
      daemonName: string;
      command: "kill" | "pause" | "resume";
    }
  | { action: "status" }
  | { action: "kill_all" }
  | { action: "noop"; reason: string };

type RoutedIntent = {
  task: boolean;
  action:
    | "chat"
    | "start_daemon"
    | "daemon_command"
    | "status"
    | "kill_all"
    | "noop";
  message?: string;
  name?: string;
  prompt?: string;
  daemonName?: string;
  command?: "kill" | "pause" | "resume";
  reason?: string;
};

type ParsedScheduleIntent = {
  daemonName: string;
  title: string;
  prompt: string;
  cronExpr: string;
  timezoneLabel: "IST" | "UTC";
  localTime: string;
};

function parseIntentJson(raw: string): RoutedIntent | null {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as RoutedIntent;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.task === "boolean" &&
        typeof parsed.action === "string"
      ) {
        return parsed;
      }
    } catch {
      // keep trying
    }
  }
  return null;
}

function isGreetingOnly(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    "hi",
    "hello",
    "hey",
    "yo",
    "sup",
    "good morning",
    "good afternoon",
    "good evening",
  ].includes(normalized);
}

function deriveDaemonNameFromText(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join("-");
  const base = slug || "task";
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}

function deriveStableDaemonName(text: string): string {
  const normalized = text.toLowerCase();
  if (normalized.includes("quote")) return "daily_quote";
  const slug = normalized
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join("_");
  return slug || "daily_task";
}

function to24Hour(hourRaw: number, minuteRaw: number, ampm?: string): { hour: number; minute: number } | null {
  let hour = hourRaw;
  const minute = minuteRaw;
  if (minute < 0 || minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    const meridiem = ampm.toLowerCase();
    if (meridiem === "am") {
      hour = hour === 12 ? 0 : hour;
    } else if (meridiem === "pm") {
      hour = hour === 12 ? 12 : hour + 12;
    } else {
      return null;
    }
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return { hour, minute };
}

function parseDailyScheduleIntent(text: string): ParsedScheduleIntent | null {
  const normalized = text.trim().toLowerCase();
  const hasDailyMarker =
    /\bevery\s*day\b/.test(normalized) ||
    /\beveryday\b/.test(normalized) ||
    /\bdaily\b/.test(normalized);
  if (!hasDailyMarker) return null;

  const timeMatch = normalized.match(
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(ist|utc)\b/
  );
  if (!timeMatch) return null;

  const parsedHour = Number.parseInt(timeMatch[1], 10);
  const parsedMinute = Number.parseInt(timeMatch[2] ?? "0", 10);
  const ampm = timeMatch[3];
  const tz = (timeMatch[4] ?? "utc").toUpperCase() as "IST" | "UTC";
  const h24 = to24Hour(parsedHour, parsedMinute, ampm);
  if (!h24) return null;

  const totalMinutesLocal = h24.hour * 60 + h24.minute;
  const offset = tz === "IST" ? 330 : 0;
  const totalMinutesUtc = ((totalMinutesLocal - offset) % 1440 + 1440) % 1440;
  const utcHour = Math.floor(totalMinutesUtc / 60);
  const utcMinute = totalMinutesUtc % 60;
  const cronExpr = `${utcMinute} ${utcHour} * * *`;

  let prompt = text
    .replace(/\bevery\s*day\b/ig, "")
    .replace(/\beveryday\b/ig, "")
    .replace(/\bdaily\b/ig, "")
    .replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:ist|utc)\b/ig, "")
    .replace(/\bi want you to\b/ig, "")
    .replace(/\bcan you\b/ig, "")
    .replace(/\bplease\b/ig, "")
    .replace(/\bmsg me\b/ig, "send me")
    .replace(/\s+/g, " ")
    .trim();
  if (!prompt) prompt = text.trim();

  const daemonName = deriveStableDaemonName(prompt || text);
  const title = daemonName;
  const localTime = `${String(h24.hour).padStart(2, "0")}:${String(h24.minute).padStart(2, "0")}`;
  return { daemonName, title, prompt, cronExpr, timezoneLabel: tz, localTime };
}

async function interpretManagerIntent(text: string): Promise<ManagerIntent> {
  if (isGreetingOnly(text)) {
    return { action: "chat", message: "Hi. What would you like me to do?" };
  }

  const daemons = listDaemons().map((d) => d.name).join(", ");
  const prompt = `You are an intent router for an orchestration manager.
Return ONLY a JSON object with this shape:
{
  "task": boolean,
  "action": "chat" | "start_daemon" | "daemon_command" | "status" | "kill_all" | "noop",
  "message"?: string,
  "name"?: string,
  "prompt"?: string,
  "daemonName"?: string,
  "command"?: "kill" | "pause" | "resume",
  "reason"?: string
}

Rules:
- "task" means: should this message create/continue executable work in a daemon?
- If task=true, action MUST be "start_daemon" with "prompt" and "name".
- If task=false, never use "start_daemon".
- Casual conversation, greetings, thanks, and non-operational chat: task=false, action="chat".
- If unclear, set task=false and ask a short clarifying chat message.

Existing daemons: ${daemons || "(none)"}
User message: ${text}`;

  let raw = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: "claude-sonnet-4-5",
        allowedTools: [],
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
    })) {
      if (msg.type === "result" && "result" in msg) {
        raw = (msg as { result: string }).result;
      }
    }
    const parsed = parseIntentJson(raw);
    if (parsed) {
      if (parsed.task) {
        const promptText = (parsed.prompt ?? text).trim() || text;
        const daemonName =
          (parsed.name ?? deriveDaemonNameFromText(promptText)).trim() ||
          deriveDaemonNameFromText(promptText);
        return {
          action: "start_daemon",
          name: daemonName,
          prompt: promptText,
        };
      }
      switch (parsed.action) {
        case "chat":
          return {
            action: "chat",
            message:
              typeof parsed.message === "string" && parsed.message.trim().length > 0
                ? parsed.message
                : "I can help with tasks. Tell me what you want me to create, analyze, or run.",
          };
        case "daemon_command":
          if (
            typeof parsed.daemonName === "string" &&
            (parsed.command === "kill" ||
              parsed.command === "pause" ||
              parsed.command === "resume")
          ) {
            return {
              action: "daemon_command",
              daemonName: parsed.daemonName,
              command: parsed.command,
            };
          }
          return {
            action: "chat",
            message: "Tell me which daemon to control and what command to run.",
          };
        case "status":
          return { action: "status" };
        case "kill_all":
          return { action: "kill_all" };
        case "noop":
          return { action: "noop", reason: parsed.reason ?? "No action needed." };
        default:
          return {
            action: "chat",
            message: "I can help with tasks. Tell me what you want me to create, analyze, or run.",
          };
      }
    }

    const fallbackTask = await fallbackTaskIntent(text);
    if (fallbackTask) {
      return {
        action: "start_daemon",
        name: deriveDaemonNameFromText(text),
        prompt: text,
      };
    }
    return {
      action: "chat",
      message: "I can help with tasks. Tell me what you want me to create, analyze, or run.",
    };
  } catch {
    const fallbackTask = await fallbackTaskIntent(text);
    if (fallbackTask) {
      return {
        action: "start_daemon",
        name: deriveDaemonNameFromText(text),
        prompt: text,
      };
    }
    return {
      action: "chat",
      message: "I can help with tasks. Tell me what you want me to create, analyze, or run.",
    };
  }
}

async function fallbackTaskIntent(text: string): Promise<boolean> {
  const prompt = `Classify if this message is an executable work request for an orchestration system.
Return ONLY JSON: {"task": true} or {"task": false}

Message:
${text}`;

  let raw = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: "claude-sonnet-4-5",
        allowedTools: [],
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
    })) {
      if (msg.type === "result" && "result" in msg) {
        raw = (msg as { result: string }).result;
      }
    }

    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenceMatch ? fenceMatch[1] : trimmed).trim();
    const parsed = JSON.parse(candidate) as { task?: unknown };
    return parsed.task === true;
  } catch {
    return false;
  }
}

export const handleManagerMessage = safe(async (ctx) => {
  const text = (ctx.message?.text ?? "").trim();
  if (!text) return;

  // Natural reply UX: replying to a daemon question routes directly to /answer flow.
  const replyTo = ctx.message?.reply_to_message;
  const chatId = String(ctx.chat?.id ?? "");
  if (replyTo?.message_id) {
    const thread = getTelegramQuestionThread(chatId, replyTo.message_id);
    if (thread) {
      const normalized = text.trim().toLowerCase();
      const daemon = getDaemon(thread.daemon_id);
      const task = getTask(thread.task_id);

      if (!daemon) {
        await ctx.reply("The related daemon no longer exists.");
        return;
      }

      if (normalized === "retry" || normalized === "/retry") {
        if (task?.status !== "failed") {
          await ctx.reply(
            task
              ? `Task "${task.title}" is ${task.status}; retry works only for failed tasks.`
              : "The related task no longer exists."
          );
          return;
        }
        resetTaskToPending(task.id);
        const alive = !!daemon.pid && isProcessAlive(daemon.pid);
        if (alive) {
          sendCommandById(daemon.id, "resume");
        } else {
          updateDaemonStatus(daemon.id, "idle");
        }
        await ctx.reply(`Retrying "${task.title}" in daemon "${daemon.name}".`);
        return;
      }

      if (normalized === "resume" || normalized === "/resume") {
        const alive = !!daemon.pid && isProcessAlive(daemon.pid);
        if (alive) {
          sendCommandById(daemon.id, "resume");
        } else {
          updateDaemonStatus(daemon.id, "idle");
        }
        await ctx.reply(`Resumed "${daemon.name}".`);
        return;
      }

      if (normalized === "pause" || normalized === "/pause") {
        sendCommandById(thread.daemon_id, "pause");
        await ctx.reply(`Paused "${daemon.name}".`);
        return;
      }

      if (
        normalized === "kill" ||
        normalized === "/kill" ||
        normalized === "stop" ||
        normalized === "cancel"
      ) {
        sendCommandById(thread.daemon_id, "kill");
        await ctx.reply(`Sent kill to "${daemon.name}".`);
        return;
      }

      if (!task) {
        await ctx.reply("The related task no longer exists.");
        return;
      }

      const replyIntent = await fallbackTaskIntent(text);
      if (!replyIntent) {
        await ctx.reply(
          "Understood. If you want me to run follow-up work, state it as a concrete request."
        );
        return;
      }

      if (task.status !== "running") {
        const followup = enqueueFollowupTask(
          daemon.id,
          task.id,
          task.title,
          task.result,
          text
        );
        updateDaemonStatus(daemon.id, "idle");
        await ctx.reply(
          `The related task "${task.title}" is ${task.status}. Started follow-up task "${followup.title}" in daemon "${daemon.name}".`
        );
        return;
      }

      sendCommandById(thread.daemon_id, "answer", {
        taskId: thread.task_id,
        text,
      });
      const alive = !!daemon.pid && isProcessAlive(daemon.pid);
      if (!alive) {
        updateDaemonStatus(daemon.id, "idle");
        await ctx.reply(
          `Queued your answer for "${task.title}". Daemon "${daemon.name}" was not running; it will be restarted.`
        );
        return;
      }
      await ctx.reply("Sent your answer to the running task.");
      return;
    }

    const normalized = text.trim().toLowerCase();
    const isInlineControl =
      normalized === "retry" ||
      normalized === "/retry" ||
      normalized === "resume" ||
      normalized === "/resume" ||
      normalized === "pause" ||
      normalized === "/pause" ||
      normalized === "kill" ||
      normalized === "/kill" ||
      normalized === "stop" ||
      normalized === "cancel";

    if (isInlineControl) {
      const repliedText = (
        replyTo.text ??
        ("caption" in replyTo ? replyTo.caption : "") ??
        ""
      ).toLowerCase();
      const all = listDaemons();
      const inferred =
        all.find((d) => {
          const n = d.name.toLowerCase();
          const variants = [n, n.replace(/[_-]+/g, " "), n.replace(/[_-]+/g, "")];
          return variants.some((v) => v.length >= 3 && repliedText.includes(v));
        }) ??
        (normalized === "retry" || normalized === "/retry"
          ? all.find((d) => getRootTask(d.id)?.status === "failed")
          : undefined);

      if (inferred) {
        const root = getRootTask(inferred.id);
        if (normalized === "retry" || normalized === "/retry") {
          if (!root || root.status !== "failed") {
            await ctx.reply(
              root
                ? `Task "${root.title}" is ${root.status}; retry works only for failed tasks.`
                : `No task found for "${inferred.name}".`
            );
            return;
          }
          resetTaskToPending(root.id);
          const alive = !!inferred.pid && isProcessAlive(inferred.pid);
          if (alive) {
            sendCommandById(inferred.id, "resume");
          } else {
            updateDaemonStatus(inferred.id, "idle");
          }
          await ctx.reply(`Retrying "${root.title}" in daemon "${inferred.name}".`);
          return;
        }

        if (normalized === "resume" || normalized === "/resume") {
          const alive = !!inferred.pid && isProcessAlive(inferred.pid);
          if (alive) {
            sendCommandById(inferred.id, "resume");
          } else {
            updateDaemonStatus(inferred.id, "idle");
          }
          await ctx.reply(`Resumed "${inferred.name}".`);
          return;
        }

        if (normalized === "pause" || normalized === "/pause") {
          sendCommandById(inferred.id, "pause");
          await ctx.reply(`Paused "${inferred.name}".`);
          return;
        }

        sendCommandById(inferred.id, "kill");
        await ctx.reply(`Sent kill to "${inferred.name}".`);
        return;
      }
    }
  }

  if (text.startsWith("/")) {
    await ctx.reply("Use natural language, or /status, /kill <daemon>, /killall.");
    return;
  }

  const parsedSchedule = parseDailyScheduleIntent(text);
  if (parsedSchedule) {
    const existing = listCronTriggers(false).find(
      (t) =>
        t.enabled === 1 &&
        t.daemon_name === parsedSchedule.daemonName &&
        t.cron_expr === parsedSchedule.cronExpr &&
        t.prompt.trim() === parsedSchedule.prompt.trim()
    );

    if (existing) {
      await ctx.reply(
        `Schedule already exists for "${parsedSchedule.daemonName}" at ${parsedSchedule.localTime} ${parsedSchedule.timezoneLabel} (cron UTC: ${parsedSchedule.cronExpr}).`
      );
      return;
    }

    const next = nextCronRun(parsedSchedule.cronExpr, new Date());
    if (!next) {
      await ctx.reply("Could not compute next run for the requested schedule.");
      return;
    }

    const trigger = createCronTrigger({
      daemonName: parsedSchedule.daemonName,
      chatId,
      title: parsedSchedule.title,
      prompt: parsedSchedule.prompt,
      cronExpr: parsedSchedule.cronExpr,
      capabilityId: undefined,
      skillsOverride: [],
      modelOverride: undefined,
      nextRunAt: next.toISOString().slice(0, 19).replace("T", " "),
      enabled: true,
    });

    await ctx.reply(
      `Scheduled "${trigger.daemon_name}" daily at ${parsedSchedule.localTime} ${parsedSchedule.timezoneLabel}.\nCron (UTC): ${trigger.cron_expr}\nNext run: ${trigger.next_run_at}\nTrigger: ${trigger.id}`
    );
    return;
  }

  const intent = await interpretManagerIntent(text);
  switch (intent.action) {
    case "chat":
      await ctx.reply(intent.message);
      return;
    case "status":
      await handleStatus(ctx);
      return;
    case "kill_all":
      await handleKillAll(ctx);
      return;
    case "daemon_command": {
      const daemon = getDaemonByName(intent.daemonName);
      if (!daemon) {
        await ctx.reply(`Daemon "${intent.daemonName}" not found.`);
        return;
      }

      if (intent.command === "resume") {
        const root = getRootTask(daemon.id);
        const alive = !!daemon.pid && isProcessAlive(daemon.pid);

        // If latest root failed, "resume" should actually requeue it.
        if (root?.status === "failed") {
          resetTaskToPending(root.id);
        }

        if (!alive) {
          updateDaemonStatus(daemon.id, "idle");
          if (!root || (root.status !== "failed" && root.status !== "pending" && root.status !== "blocked")) {
            await ctx.reply(`"${intent.daemonName}" has no resumable work. Tell me what new work to start.`);
            return;
          }
          await ctx.reply(`Resumed "${intent.daemonName}" by re-queuing work and waking the manager.`);
          return;
        }

        sendCommand(intent.daemonName, "resume");
        await ctx.reply(`Sent resume to "${intent.daemonName}".`);
        return;
      }

      const sent = sendCommand(intent.daemonName, intent.command);
      await ctx.reply(sent ? `Sent ${intent.command} to "${intent.daemonName}".` : `Daemon "${intent.daemonName}" not found.`);
      return;
    }
    case "start_daemon": {
      const daemon = requestDaemonStart(intent.name, intent.prompt, chatId);
      const root = getRootTask(daemon.id);
      const sourceMessageId = ctx.message?.message_id;
      if (root && sourceMessageId) {
        upsertTelegramQuestionThread({
          daemonId: daemon.id,
          taskId: root.id,
          chatId,
          questionMessageId: sourceMessageId,
        });
      }
      await ctx.reply(
        `Queued "${daemon.name}". I will manage execution and send updates here.`
      );
      return;
    }
    case "noop":
    default:
      await ctx.reply(`I can help run or control work. Tell me what you want done.`);
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
