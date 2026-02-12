import type { AgentRole, McpServerConfig } from "../shared/types.js";

/**
 * Default MCP server definitions per role.
 * These are used when no database overrides exist.
 * Set roles to null to apply to all roles.
 */
export const DEFAULT_MCP_SERVERS: Record<
  string,
  { roles: AgentRole[] | null; config: McpServerConfig }
> = {
  github: {
    roles: ["lead", "reviewer", "tester"],
    config: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
    },
  },
  postgres: {
    roles: ["backend-dev", "db-admin"],
    config: {
      command: "npx",
      args: ["-y", "@bytebase/dbhub", "--dsn", process.env.OW_DB_URL ?? ""],
    },
  },
};
