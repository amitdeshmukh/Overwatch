import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { parseArgs } from "node:util";
import { Bot, InputFile } from "grammy";
import { getDb, closeDb } from "../db/index.js";
import {
  getOrCreateDaemon,
  createTask,
  updateDaemonPid,
  updateDaemonStatus,
  getRootTask,
} from "../db/queries.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { Scheduler } from "./scheduler.js";
import {
  registerShutdownHandlers,
  writePidFile,
  removePidFile,
} from "./lifecycle.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ensureSkillLibrary } from "../skills/library.js";
import type { DaemonContext } from "../shared/types.js";

const log = createLogger("daemon");

const FORMAT_PROMPT = `You are a Telegram message formatter. Given an agent's raw output (which may be JSON, markdown, plain text, or a mix), produce a short, clean message suitable for a Telegram DM.

Rules:
- Extract the essential information the user cares about
- Keep it concise — 1-3 sentences max
- No JSON, no code blocks, no markdown formatting
- No internal file paths or technical metadata
- If the agent produced files/images, just say what was created
- If it's an error, say what went wrong simply
- Plain text only

Respond with ONLY the formatted message, nothing else.`;

/**
 * Use opus to turn raw agent output into a clean Telegram message.
 */
async function formatForTelegram(raw: string): Promise<string> {
  try {
    let result = "";
    for await (const message of query({
      prompt: `${FORMAT_PROMPT}\n\nAgent output:\n${raw}`,
      options: {
        model: "claude-opus-4-6",
        allowedTools: [],
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
    })) {
      if (message.type === "result" && "result" in message) {
        result = (message as { result: string }).result;
      }
    }
    return result || raw.slice(0, 500);
  } catch (err) {
    log.warn("Failed to format message with LLM", { error: String(err) });
    return raw.slice(0, 500);
  }
}

/**
 * Recursively scan workspace for image files, skipping venv/.claude dirs.
 */
function findWorkspaceImages(workdir: string): string[] {
  const images: string[] = [];
  const SKIP = new Set(["venv", ".venv", "node_modules", ".claude", ".git", "__pycache__", ".env"]);

  function scan(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP.has(entry.name)) scan(join(dir, entry.name));
        } else if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(entry.name)) {
          images.push(join(dir, entry.name));
        }
      }
    } catch {
      // ignore permission errors etc.
    }
  }

  try {
    if (!existsSync(workdir)) return images;
    scan(workdir);
  } catch {
    // ignore
  }
  return images;
}

async function sendTelegramText(bot: Bot, chatId: string, text: string): Promise<void> {
  const encoder = new TextEncoder();
  let safe = text;
  if (encoder.encode(text).length > 4096) {
    const suffix = "\n...(truncated)";
    const target = 4096 - encoder.encode(suffix).length;
    let end = text.length;
    while (encoder.encode(text.slice(0, end)).length > target) {
      end = Math.floor(end * 0.9);
    }
    safe = text.slice(0, end) + suffix;
  }
  if (safe) {
    await bot.api.sendMessage(chatId, safe);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      prompt: { type: "string" },
      "chat-id": { type: "string" },
    },
    strict: false,
  });

  const name = values.name as string | undefined;
  const prompt = values.prompt as string | undefined;
  const chatId = values["chat-id"] as string | undefined;

  if (!name) {
    console.error(
      "Usage: overwatch-daemon --name <project> [--prompt <text>] [--chat-id <id>]"
    );
    process.exit(1);
  }

  // Initialize database
  getDb();

  // Download skill library if not present (no-op if already installed)
  await ensureSkillLibrary();

  // Ensure workspace directory exists
  const workdir = resolve(config.workspacesDir, name);
  mkdirSync(workdir, { recursive: true });

  // Create or resume daemon
  const daemon = getOrCreateDaemon(name, chatId);
  log.info("Daemon starting", {
    id: daemon.id,
    name,
    pid: process.pid,
  });

  // Record PID
  updateDaemonPid(daemon.id, process.pid);
  writePidFile(name);

  const ctx: DaemonContext = {
    daemonId: daemon.id,
    daemonName: name,
    chatId: daemon.chat_id ?? chatId ?? null,
    workdir,
  };

  // Create root task if prompt provided and no existing work
  if (prompt) {
    const existingRoot = getRootTask(daemon.id);
    if (!existingRoot) {
      createTask({
        daemonId: daemon.id,
        title: name,
        prompt,
      });
      log.info("Created root task", { title: name });
    }
  }

  // Set up Telegram messaging if chat_id is available
  const scheduler = new Scheduler(ctx);

  if (ctx.chatId) {
    try {
      const bot = new Bot(config.telegramToken());
      // Track which images we've already sent to avoid duplicates
      const sentImages = new Set<string>();

      scheduler.sendMessage = async (text: string) => {
        // Use LLM to produce a clean Telegram message from raw agent output
        const formatted = await formatForTelegram(text);
        await sendTelegramText(bot, ctx.chatId!, formatted);

        // Send any images the agent produced
        for (const imgPath of findWorkspaceImages(ctx.workdir)) {
          if (sentImages.has(imgPath)) continue;
          sentImages.add(imgPath);
          try {
            await bot.api.sendPhoto(ctx.chatId!, new InputFile(imgPath, basename(imgPath)));
          } catch (err) {
            log.warn("Failed to send image to Telegram", { path: imgPath, error: String(err) });
          }
        }
      };
      log.info("Telegram messaging enabled", { chatId: ctx.chatId });
    } catch (err) {
      log.warn("Could not initialize Telegram messaging", {
        error: String(err),
      });
    }
  }

  // Register shutdown handlers and start
  registerShutdownHandlers(daemon.id, name, scheduler);
  await scheduler.start();

  log.info("Daemon running", { name, pid: process.pid });
}

main().catch((err) => {
  log.error("Daemon failed to start", { error: String(err) });
  closeDb();
  process.exit(1);
});
