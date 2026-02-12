import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Bot } from "grammy";
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
import { ensureSkillLibrary } from "../skills/library.js";
import type { DaemonContext } from "../shared/types.js";

const log = createLogger("daemon");

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
      scheduler.sendMessage = async (text: string) => {
        // Telegram limit is 4096 bytes, not characters
        const encoder = new TextEncoder();
        let safe = text;
        if (encoder.encode(text).length > 4096) {
          const suffix = "\n...(truncated)";
          const target = 4096 - encoder.encode(suffix).length;
          // Find safe character cutoff
          let end = text.length;
          while (encoder.encode(text.slice(0, end)).length > target) {
            end = Math.floor(end * 0.9);
          }
          safe = text.slice(0, end) + suffix;
        }
        await bot.api.sendMessage(ctx.chatId!, safe);
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
