import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (process.env.OW_LOG_LEVEL as LogLevel) ?? "info";

/** Optional file logging directory. Set OW_LOG_DIR to enable. */
const logDir = process.env.OW_LOG_DIR;

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatMessage(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>
): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase().padEnd(5)}] [${component}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

function writeToFile(component: string, formatted: string): void {
  if (!logDir) return;
  try {
    mkdirSync(logDir, { recursive: true });
    const logFile = resolve(logDir, `${component}.log`);
    appendFileSync(logFile, formatted + "\n");
  } catch {
    // Don't crash if file logging fails
  }
}

export function createLogger(component: string) {
  return {
    debug(message: string, data?: Record<string, unknown>) {
      if (shouldLog("debug")) {
        const fmt = formatMessage("debug", component, message, data);
        console.debug(fmt);
        writeToFile(component, fmt);
      }
    },
    info(message: string, data?: Record<string, unknown>) {
      if (shouldLog("info")) {
        const fmt = formatMessage("info", component, message, data);
        console.info(fmt);
        writeToFile(component, fmt);
      }
    },
    warn(message: string, data?: Record<string, unknown>) {
      if (shouldLog("warn")) {
        const fmt = formatMessage("warn", component, message, data);
        console.warn(fmt);
        writeToFile(component, fmt);
      }
    },
    error(message: string, data?: Record<string, unknown>) {
      if (shouldLog("error")) {
        const fmt = formatMessage("error", component, message, data);
        console.error(fmt);
        writeToFile(component, fmt);
      }
    },
  };
}
