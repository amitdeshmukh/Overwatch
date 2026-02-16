import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveMcpServers } from "../mcp/registry.js";
import { injectSkills } from "../skills/index.js";
import { buildHooks, handleInitMessage } from "./hooks.js";
import { isCapabilityBudgetExceeded, recordCost } from "./budget.js";
import { runRlmStyleAnalysis } from "./rlm.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import {
  initializeTaskMetadata,
  recordToolUsage,
  incrementTaskTurnCount,
  getTaskDepth,
  insertEvent,
  insertAgentTrace,
  getTask,
  getCapability,
} from "../db/queries.js";
import type {
  TaskRow,
  AgentHandle,
  DaemonContext,
} from "../shared/types.js";

const log = createLogger("agent-pool");

// Constants for depth limits
const MAX_TASK_DEPTH = 3;
const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Glob",
  "Grep",
  "Skill",
  "AskUserQuestion",
] as const;
const capabilityRunWindow = new Map<string, number[]>();

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function allowCapabilityRun(capabilityId: string, rateLimitPerMin: number): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const timestamps = capabilityRunWindow.get(capabilityId) ?? [];
  const recent = timestamps.filter((ts) => ts >= cutoff);
  if (recent.length >= rateLimitPerMin) return false;
  recent.push(now);
  capabilityRunWindow.set(capabilityId, recent);
  return true;
}

export class AgentPool {
  private agents = new Map<string, AgentHandle>();
  private ctx: DaemonContext;

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
    // Initialize task depth tracking
    if (!this.ctx.taskDepths) {
      this.ctx.taskDepths = new Map();
    }
  }

  get runningCount(): number {
    return this.agents.size;
  }

  isRunning(taskId: string): boolean {
    return this.agents.has(taskId);
  }

  spawn(
    task: TaskRow,
    onComplete: (taskId: string, result: string) => void,
    onError: (taskId: string, error: Error) => void
  ): void {
    if (this.agents.has(task.id)) {
      log.warn("Agent already running for task", { taskId: task.id });
      return;
    }

    // Check task depth limit
    const depth = getTaskDepth(task.id);
    if (depth > MAX_TASK_DEPTH) {
      log.warn("Task depth limit exceeded", {
        taskId: task.id,
        depth,
        maxDepth: MAX_TASK_DEPTH,
      });
      insertEvent({
        daemonId: this.ctx.daemonId,
        taskId: task.id,
        type: "depth_limit_exceeded",
        payload: { depth, maxDepth: MAX_TASK_DEPTH },
      });
      onError(
        task.id,
        new Error(
          `Task depth limit exceeded (${depth} > ${MAX_TASK_DEPTH}). Sub-agents cannot spawn more sub-agents.`
        )
      );
      return;
    }

    this.ctx.taskDepths!.set(task.id, depth);

    const capability = task.capability_id ? getCapability(task.capability_id) : undefined;
    const capabilitySkills = capability ? parseJsonArray(capability.default_skills || "[]") : [];
    const allowedTools = capability ? parseJsonArray(capability.allowed_tools || "[]") : [];
    const allowedMcpServers = capability ? parseJsonArray(capability.allowed_mcp_servers || "[]") : [];
    const mcpServers = resolveMcpServers("backend-dev", allowedMcpServers);
    const hooks = buildHooks(this.ctx, task.id);

    if (capability?.rate_limit_per_min && capability.rate_limit_per_min > 0) {
      if (!allowCapabilityRun(capability.id, capability.rate_limit_per_min)) {
        onError(
          task.id,
          new Error(`Capability rate limit exceeded for "${capability.id}"`)
        );
        return;
      }
    }

    if (
      capability &&
      isCapabilityBudgetExceeded(capability.id, capability.budget_cap_usd)
    ) {
      onError(task.id, new Error(`Capability budget exceeded for "${capability.id}"`));
      return;
    }

    // Initialize task metadata for loop detection
    initializeTaskMetadata(task.id);

    // Inject library skills into the workspace (no role persona)
    const taskSkills: string[] = JSON.parse(task.skills || "[]");
    const mergedSkills = Array.from(new Set([...capabilitySkills, ...taskSkills]));
    injectSkills(this.ctx.workdir, null, mergedSkills);

    const abortController = new AbortController();
    let timedOut = false;
    const timeoutMs = capability?.timeout_ms ?? config.agentTimeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      log.warn("Agent timed out", { taskId: task.id });
      abortController.abort();
    }, timeoutMs);

    log.info("Spawning agent", {
      taskId: task.id,
      title: task.title,
    });

    const handle: AgentHandle = {
      taskId: task.id,
      sessionId: null,
      abortController,
      promise: (capability?.id === "long-context-analysis"
        ? this.runLongContextCapability(task, abortController, capability?.default_model ?? null)
        : this.runAgent(
            task,
            mcpServers,
            hooks,
            abortController,
            capability?.default_model ?? null,
            allowedTools.length > 0 ? allowedTools : [...DEFAULT_ALLOWED_TOOLS],
            capability?.max_turns ?? 50
          ))
        .then((result) => {
          clearTimeout(timeout);
          this.agents.delete(task.id);
          log.info("Agent completed", { taskId: task.id });
          onComplete(task.id, result);
          return result;
        })
        .catch((error: Error) => {
          clearTimeout(timeout);
          this.agents.delete(task.id);
          const mappedError = timedOut
            ? new Error(
                `Task timed out after ${Math.round(
                  timeoutMs / 1000
                )}s`
              )
            : error;
          log.error("Agent failed", {
            taskId: task.id,
            error: mappedError.message,
          });
          onError(task.id, mappedError);
          return "";
        }),
    };

    this.agents.set(task.id, handle);
  }

  resumeAgent(
    task: TaskRow,
    userResponse: string,
    onComplete: (taskId: string, result: string) => void,
    onError: (taskId: string, error: Error) => void
  ): void {
    if (!task.agent_session_id) {
      onError(task.id, new Error("No session ID to resume"));
      return;
    }

    if (this.agents.has(task.id)) {
      log.warn("Agent already running for task, cannot resume", {
        taskId: task.id,
      });
      return;
    }

    const capability = task.capability_id ? getCapability(task.capability_id) : undefined;
    const capabilitySkills = capability ? parseJsonArray(capability.default_skills || "[]") : [];
    const allowedTools = capability ? parseJsonArray(capability.allowed_tools || "[]") : [];
    const allowedMcpServers = capability ? parseJsonArray(capability.allowed_mcp_servers || "[]") : [];
    const mcpServers = resolveMcpServers("backend-dev", allowedMcpServers);
    const hooks = buildHooks(this.ctx, task.id);
    const abortController = new AbortController();

    // Re-inject library skills for resume (no role persona)
    const taskSkills: string[] = JSON.parse(task.skills || "[]");
    const mergedSkills = Array.from(new Set([...capabilitySkills, ...taskSkills]));
    injectSkills(this.ctx.workdir, null, mergedSkills);

    let timedOut = false;
    const timeoutMs = capability?.timeout_ms ?? config.agentTimeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    log.info("Resuming agent", {
      taskId: task.id,
      sessionId: task.agent_session_id,
    });

    const handle: AgentHandle = {
      taskId: task.id,
      sessionId: task.agent_session_id,
      abortController,
      promise: this.runAgentWithResume(
        task,
        userResponse,
        mcpServers,
        hooks,
        abortController,
        capability?.default_model ?? null,
        allowedTools.length > 0 ? allowedTools : [...DEFAULT_ALLOWED_TOOLS],
        capability?.max_turns ?? 50
      )
        .then((result) => {
          clearTimeout(timeout);
          this.agents.delete(task.id);
          onComplete(task.id, result);
          return result;
        })
        .catch((error: Error) => {
          clearTimeout(timeout);
          this.agents.delete(task.id);
          const mappedError = timedOut
            ? new Error(
                `Task timed out after ${Math.round(
                  timeoutMs / 1000
                )}s`
              )
            : error;
          onError(task.id, mappedError);
          return "";
        }),
    };

    this.agents.set(task.id, handle);
  }

  private async runAgent(
    task: TaskRow,
    mcpServers: Record<string, unknown>,
    hooks: Record<string, unknown>,
    abortController: AbortController,
    capabilityDefaultModel: string | null,
    allowedTools: string[],
    maxTurns: number
  ): Promise<string> {
    let result = "";
    const model = task.agent_model ?? capabilityDefaultModel ?? config.model;

    const resultSchema = JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["status", "message"],
      properties: {
        status: { type: "string", enum: ["success", "error"] },
        message: { type: "string", description: "1-2 sentence summary" },
        data: { type: "object", description: "Optional skill-specific metadata" },
      },
      additionalProperties: false,
    });

    for await (const message of query({
      prompt: `Your final response must be ONLY a JSON object conforming to this JSON Schema:\n${resultSchema}\n\nTask: ${task.title}\n\n${task.prompt}`,
      options: {
        model,
        cwd: this.ctx.workdir,
        allowedTools,
        permissionMode: "bypassPermissions",
        mcpServers: mcpServers as Record<string, never>,
        hooks: hooks as Record<string, never>,
        settingSources: ["project"],
        maxTurns,
        abortController,
      },
    })) {
      this.handleMessage(task.id, message, model);
      if (message.type === "result" && "result" in message) {
        result = (message as { result: string }).result;
      }
    }

    return result;
  }

  private async runLongContextCapability(
    task: TaskRow,
    abortController: AbortController,
    capabilityDefaultModel: string | null
  ): Promise<string> {
    const model = task.agent_model ?? capabilityDefaultModel ?? "opus";
    insertAgentTrace({
      daemonId: this.ctx.daemonId,
      taskId: task.id,
      parentTaskId: task.parent_id ?? null,
      source: "agent",
      eventType: "capability_run",
      eventSubtype: "long-context-analysis:start",
      payload: { model },
    });
    const output = await runRlmStyleAnalysis({
      task,
      workdir: this.ctx.workdir,
      model,
      abortController,
    });

    if (output.totalCostUsd > 0) {
      recordCost(this.ctx.daemonId, output.totalCostUsd, task.capability_id);
    }
    insertAgentTrace({
      daemonId: this.ctx.daemonId,
      taskId: task.id,
      parentTaskId: task.parent_id ?? null,
      source: "agent",
      eventType: "capability_run",
      eventSubtype: "long-context-analysis:done",
      payload: { model, totalCostUsd: output.totalCostUsd },
    });
    return output.rawResult;
  }

  private async runAgentWithResume(
    task: TaskRow,
    userResponse: string,
    mcpServers: Record<string, unknown>,
    hooks: Record<string, unknown>,
    abortController: AbortController,
    capabilityDefaultModel: string | null,
    allowedTools: string[],
    maxTurns: number
  ): Promise<string> {
    let result = "";
    const model = task.agent_model ?? capabilityDefaultModel ?? config.model;

    for await (const message of query({
      prompt: userResponse,
      options: {
        model,
        cwd: this.ctx.workdir,
        allowedTools,
        permissionMode: "bypassPermissions",
        mcpServers: mcpServers as Record<string, never>,
        hooks: hooks as Record<string, never>,
        settingSources: ["project"],
        maxTurns,
        resume: task.agent_session_id!,
        abortController,
      },
    })) {
      this.handleMessage(task.id, message, model);
      if (message.type === "result" && "result" in message) {
        result = (message as { result: string }).result;
      }
    }

    return result;
  }

  private handleMessage(
    taskId: string,
    message: Record<string, unknown>,
    model: string
  ): void {
    const safePayload = sanitizeTracePayload(message);
    const taskForTrace = getTask(taskId);
    insertAgentTrace({
      daemonId: this.ctx.daemonId,
      taskId,
      parentTaskId: taskForTrace?.parent_id ?? null,
      source: "agent",
      eventType: String(message.type ?? "unknown"),
      eventSubtype:
        typeof message.subtype === "string" ? message.subtype : null,
      payload: {
        model,
        ...safePayload,
      },
    });

    if (
      message.type === "system" &&
      message.subtype === "init"
    ) {
      handleInitMessage(
        taskId,
        message as { session_id?: string }
      );
      const handle = this.agents.get(taskId);
      if (handle) {
        handle.sessionId =
          (message as { session_id?: string }).session_id ?? null;
      }
    }

    // Track tool usage for loop detection
    if (message.type === "tool_use") {
      const toolName = (message as { tool_name?: string }).tool_name;
      if (toolName) {
        recordToolUsage(taskId, toolName);
      }
    }

    // Detect tool loops after each turn
    if (message.type === "content" && "content" in message) {
      const task = getTask(taskId);
      if (!task) return;

      const turnNum = incrementTaskTurnCount(taskId);

      // Check for loops every 5 turns after turn 15
      if (turnNum >= 15 && turnNum % 5 === 0) {
        // This is a simplified check - in production you'd fetch recent_tools
        // For now, we log and let the maxTurns limit handle it
        log.debug("Loop check", {
          taskId,
          turn: turnNum,
        });
      }
    }

    if (message.type === "result") {
      const totalCost = (
        message as { total_cost_usd?: number }
      ).total_cost_usd;
      if (totalCost !== undefined && totalCost > 0) {
        const task = getTask(taskId);
        const withinBudget = recordCost(
          this.ctx.daemonId,
          totalCost,
          task?.capability_id
        );
        if (!withinBudget) {
          log.warn("Budget exceeded after agent completion", {
            taskId,
            totalCost,
          });
        }
      }
    }
  }

  kill(taskId: string): boolean {
    const agent = this.agents.get(taskId);
    if (!agent) return false;

    log.info("Killing agent", { taskId });
    agent.abortController.abort();
    this.agents.delete(taskId);
    return true;
  }

  killAll(): void {
    log.info("Killing all agents", { count: this.agents.size });
    for (const [, agent] of this.agents) {
      agent.abortController.abort();
    }
    this.agents.clear();
  }

  async drain(): Promise<void> {
    const promises = Array.from(this.agents.values()).map(
      (a) => a.promise
    );
    await Promise.allSettled(promises);
  }
}

function sanitizeTracePayload(message: Record<string, unknown>): Record<string, unknown> {
  const MAX_JSON_BYTES = 8000;
  try {
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw, "utf-8") <= MAX_JSON_BYTES) {
      return message;
    }
    const trimmed = raw.slice(0, MAX_JSON_BYTES);
    return {
      truncated: true,
      approx_bytes: Buffer.byteLength(raw, "utf-8"),
      preview: trimmed,
    };
  } catch {
    return {
      truncated: true,
      note: "non-serializable message payload",
      preview: String(message),
    };
  }
}
