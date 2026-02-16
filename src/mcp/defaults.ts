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
  email: {
    roles: null,
    config: {
      type: "http",
      url: process.env.OW_MCP_EMAIL_URL ?? "http://localhost:8071/mcp",
    },
  },
  analytics: {
    roles: null,
    config: {
      type: "http",
      url: process.env.OW_MCP_ANALYTICS_URL ?? "http://localhost:8072/mcp",
    },
  },
  "google-ads": {
    roles: null,
    config: {
      type: "http",
      url: process.env.OW_MCP_GOOGLE_ADS_URL ?? "http://localhost:8073/mcp",
    },
  },
  "meta-ads": {
    roles: null,
    config: {
      type: "http",
      url: process.env.OW_MCP_META_ADS_URL ?? "http://localhost:8074/mcp",
    },
  },
};
