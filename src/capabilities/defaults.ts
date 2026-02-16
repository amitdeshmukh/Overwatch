import type { AgentModel, ExecMode } from "../shared/types.js";

export interface CapabilityPolicyDefault {
  id: string;
  name: string;
  description: string;
  defaultModel?: AgentModel;
  defaultExecMode?: ExecMode;
  defaultSkills?: string[];
  allowedTools?: string[];
  allowedMcpServers?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  rateLimitPerMin?: number;
  budgetCapUsd?: number;
}

export const DEFAULT_CAPABILITY_POLICIES: CapabilityPolicyDefault[] = [
  {
    id: "general",
    name: "general",
    description: "General-purpose capability for unspecialized tasks.",
    defaultExecMode: "auto",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Skill", "AskUserQuestion"],
    maxTurns: 50,
    timeoutMs: 600000,
    rateLimitPerMin: 20,
  },
  {
    id: "email-triage",
    name: "email-triage",
    description: "Email processing and triage workflows via MCP connectors.",
    defaultModel: "sonnet",
    defaultSkills: ["email-triage"],
    allowedTools: ["Read", "Write", "Bash", "Glob", "Grep", "Skill", "AskUserQuestion"],
    allowedMcpServers: ["email"],
    maxTurns: 40,
    timeoutMs: 300000,
    rateLimitPerMin: 10,
  },
  {
    id: "marketing-ops",
    name: "marketing-ops",
    description: "Marketing analysis and campaign automation.",
    defaultModel: "sonnet",
    defaultSkills: ["market-research", "marketing-analytics"],
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Skill", "AskUserQuestion"],
    allowedMcpServers: ["google-ads", "meta-ads", "analytics"],
    maxTurns: 50,
    timeoutMs: 600000,
    rateLimitPerMin: 15,
  },
  {
    id: "long-context-analysis",
    name: "long-context-analysis",
    description: "RLM-style recursive analysis for very large local corpora (logs, docs, transcripts).",
    defaultModel: "opus",
    defaultExecMode: "auto",
    // Executed via dedicated RLM path, not normal tool loop.
    allowedTools: [],
    maxTurns: 24,
    timeoutMs: 900000,
    rateLimitPerMin: 4,
    budgetCapUsd: 10,
  },
];
