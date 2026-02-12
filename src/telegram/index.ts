import { Bot } from "grammy";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { getDb, closeDb } from "../db/index.js";
import {
  handleStart,
  handleStatus,
  handleTree,
  handleKill,
  handlePause,
  handleResume,
  handleRetry,
  handleLogs,
  handleAnswer,
  handleConfig,
} from "./commands.js";

const log = createLogger("telegram");

async function main(): Promise<void> {
  // Ensure database is initialized
  getDb();

  const bot = new Bot(config.telegramToken());

  // Auth middleware — default-deny when OW_ALLOWED_USERS is not set
  const allowedUsers = config.allowedUsers;
  bot.use(async (ctx, next) => {
    const username = ctx.from?.username?.toLowerCase();
    if (allowedUsers.length === 0) {
      // No allowlist configured — reject all with setup instructions
      log.warn("No OW_ALLOWED_USERS configured, rejecting all", {
        userId: ctx.from?.id,
      });
      await ctx.reply(
        "Bot is not configured. Set OW_ALLOWED_USERS in your environment."
      );
      return;
    }
    if (username && allowedUsers.includes(username)) {
      await next();
    } else {
      log.warn("Unauthorized access attempt", { userId: ctx.from?.id, username });
      await ctx.reply("Unauthorized.");
    }
  });

  // Register commands
  bot.command("start", handleStart);
  bot.command("status", handleStatus);
  bot.command("tree", handleTree);
  bot.command("kill", handleKill);
  bot.command("pause", handlePause);
  bot.command("resume", handleResume);
  bot.command("retry", handleRetry);
  bot.command("logs", handleLogs);
  bot.command("answer", handleAnswer);
  bot.command("config", handleConfig);

  // Fallback
  bot.on("message:text", async (ctx) => {
    await ctx.reply(
      "Commands:\n" +
        "/start <name> <desc> — Start a new project\n" +
        "/status — List all daemons\n" +
        "/tree <name> — Show task tree\n" +
        "/kill <name> — Stop a daemon\n" +
        "/pause <name> — Pause a daemon\n" +
        "/resume <name> — Resume a daemon\n" +
        "/retry <task-id> — Retry a failed task\n" +
        "/logs <task-id> — View task output\n" +
        "/answer <task-id> <text> — Answer agent question\n" +
        "/config — Manage MCP configs"
    );
  });

  // Graceful shutdown — daemons keep running
  const shutdown = () => {
    log.info("Shutting down Telegram bot (daemons continue running)");
    bot.stop();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("Starting Telegram bot (stateless relay)");
  await bot.start();
}

main().catch((err) => {
  log.error("Telegram bot failed to start", { error: String(err) });
  closeDb();
  process.exit(1);
});
