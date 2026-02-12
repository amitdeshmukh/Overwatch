import "dotenv/config";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function envInt(key: string, fallback: string, min = 1): number {
  const raw = env(key, fallback);
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) {
    throw new Error(
      `Invalid value for ${key}: "${raw}" (expected integer >= ${min})`
    );
  }
  return parsed;
}

function envFloat(key: string, fallback: string, min = 0): number {
  const raw = env(key, fallback);
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < min) {
    throw new Error(
      `Invalid value for ${key}: "${raw}" (expected number >= ${min})`
    );
  }
  return parsed;
}

const owHome = resolve(homedir(), ".overwatch");

export const config = {
  /** Telegram bot token from BotFather */
  telegramToken: () => env("OW_TELEGRAM_TOKEN"),

  /** Anthropic API key for Claude Agent SDK */
  anthropicApiKey: () => env("ANTHROPIC_API_KEY"),

  /** SQLite database path */
  dbPath: env("OW_DB_PATH", resolve(owHome, "overwatch.db")),

  /** Base directory for daemon workspaces */
  workspacesDir: env("OW_WORKSPACES_DIR", resolve(owHome, "workspaces")),

  /** Log directory */
  logDir: env("OW_LOG_DIR", resolve(owHome, "logs")),

  /** PID file directory */
  pidDir: env("OW_PID_DIR", resolve(owHome, "pids")),

  /** Skills directory — resolved relative to project root, not compiled output */
  skillsDir: env("OW_SKILLS_DIR", resolve(__dirname, "..", "skills")),

  /** Skill library directory — external skills from e.g. anthropics/skills */
  skillLibraryDir: env("OW_SKILL_LIBRARY_DIR", resolve(owHome, "skill-library")),

  /** Bundled skills directory — built-in skills shipped with the repo */
  bundledSkillsDir: resolve(__dirname, "..", "skills", "library"),

  /** Default model for agent SDK queries */
  model: env("OW_MODEL", "sonnet"),

  /** Max concurrent agents per daemon */
  maxAgentsPerDaemon: envInt("OW_MAX_AGENTS", "5"),

  /** Agent query timeout in ms (default 10 minutes) */
  agentTimeoutMs: envInt("OW_AGENT_TIMEOUT_MS", "600000", 5000),

  /** Daemon poll interval in ms */
  pollIntervalMs: envInt("OW_POLL_INTERVAL_MS", "2000", 500),

  /** Allowed Telegram usernames (comma-separated, without @). Empty = reject all. */
  allowedUsers: env("OW_ALLOWED_USERS", "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),

  /** Per-daemon budget cap in USD (0 = unlimited) */
  budgetCapUsd: envFloat("OW_BUDGET_CAP_USD", "0"),

  /** Web dashboard port */
  webPort: envInt("OW_WEB_PORT", "7777", 1),
} as const;
