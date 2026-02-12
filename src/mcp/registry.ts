import { getMcpConfigsForRole } from "../db/queries.js";
import { DEFAULT_MCP_SERVERS } from "./defaults.js";
import type { AgentRole, McpServerConfig } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mcp-registry");

/**
 * Validate that an MCP config has the minimum required fields.
 */
function isValidConfig(config: unknown): config is McpServerConfig {
  if (typeof config !== "object" || config === null) return false;
  const obj = config as Record<string, unknown>;

  // HTTP config
  if (obj.type === "http") {
    return typeof obj.url === "string" && obj.url.length > 0;
  }

  // stdio config
  return typeof obj.command === "string" && obj.command.length > 0;
}

/**
 * Resolve MCP server configs for a given agent role.
 * Merges database configs with defaults (DB takes precedence).
 */
export function resolveMcpServers(
  role: AgentRole
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};

  // Apply defaults for this role
  for (const [name, def] of Object.entries(DEFAULT_MCP_SERVERS)) {
    if (def.roles === null || def.roles.includes(role)) {
      if (isValidConfig(def.config)) {
        result[name] = def.config;
      } else {
        log.debug("Skipping invalid default MCP config", { name });
      }
    }
  }

  // Override with database configs
  try {
    const dbConfigs = getMcpConfigsForRole(role);
    for (const row of dbConfigs) {
      try {
        const parsed = JSON.parse(row.config);
        if (isValidConfig(parsed)) {
          result[row.name] = parsed;
        } else {
          log.warn("Invalid MCP config in database, skipping", {
            name: row.name,
            role: row.role,
          });
        }
      } catch (parseErr) {
        log.warn("Malformed JSON in MCP config, skipping", {
          name: row.name,
          error: String(parseErr),
        });
      }
    }
  } catch (err) {
    log.warn("Failed to load MCP configs from database", {
      error: String(err),
    });
  }

  log.debug("Resolved MCP servers", {
    role,
    servers: Object.keys(result),
  });
  return result;
}
