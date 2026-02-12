import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveMcpServers } from "../mcp/registry.js";
import { injectSkills } from "../skills/index.js";
import { buildHooks, handleInitMessage } from "./hooks.js";
import { recordCost } from "./budget.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import type {
  TaskRow,
  AgentHandle,
  AgentRole,
  DaemonContext,
} from "../shared/types.js";

const log = createLogger("agent-pool");

export class AgentPool {
  private agents = new Map<string, AgentHandle>();
  private ctx: DaemonContext;

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
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

    const role = (task.agent_role ?? "backend-dev") as AgentRole;
    const mcpServers = resolveMcpServers(role);
    const hooks = buildHooks(this.ctx, task.id);

    // Inject the role's skill and any library skills into the workspace
    const taskSkills: string[] = JSON.parse(task.skills || "[]");
    injectSkills(this.ctx.workdir, role, taskSkills);

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      log.warn("Agent timed out", { taskId: task.id });
      abortController.abort();
    }, config.agentTimeoutMs);

    log.info("Spawning agent", {
      taskId: task.id,
      role,
      title: task.title,
    });

    const handle: AgentHandle = {
      taskId: task.id,
      sessionId: null,
      abortController,
      promise: this.runAgent(task, mcpServers, hooks, abortController)
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
          log.error("Agent failed", {
            taskId: task.id,
            error: error.message,
          });
          onError(task.id, error);
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

    const role = (task.agent_role ?? "backend-dev") as AgentRole;
    const mcpServers = resolveMcpServers(role);
    const hooks = buildHooks(this.ctx, task.id);
    const abortController = new AbortController();

    // Re-inject role skill and library skills for resume
    const taskSkills: string[] = JSON.parse(task.skills || "[]");
    injectSkills(this.ctx.workdir, role, taskSkills);

    const timeout = setTimeout(() => {
      abortController.abort();
    }, config.agentTimeoutMs);

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
        abortController
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
          onError(task.id, error);
          return "";
        }),
    };

    this.agents.set(task.id, handle);
  }

  private async runAgent(
    task: TaskRow,
    mcpServers: Record<string, unknown>,
    hooks: Record<string, unknown>,
    abortController: AbortController
  ): Promise<string> {
    let result = "";

    for await (const message of query({
      prompt: `Task: ${task.title}\n\n${task.prompt}`,
      options: {
        model: task.agent_model ?? config.model,
        cwd: this.ctx.workdir,
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "Bash",
          "Glob",
          "Grep",
          "Skill",
        ],
        permissionMode: "bypassPermissions",
        mcpServers: mcpServers as Record<string, never>,
        hooks: hooks as Record<string, never>,
        settingSources: ["project"],
        maxTurns: 50,
        abortController,
      },
    })) {
      this.handleMessage(task.id, message);
      if (message.type === "result" && "result" in message) {
        result = (message as { result: string }).result;
      }
    }

    return result;
  }

  private async runAgentWithResume(
    task: TaskRow,
    userResponse: string,
    mcpServers: Record<string, unknown>,
    hooks: Record<string, unknown>,
    abortController: AbortController
  ): Promise<string> {
    let result = "";

    for await (const message of query({
      prompt: userResponse,
      options: {
        model: task.agent_model ?? config.model,
        cwd: this.ctx.workdir,
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "Bash",
          "Glob",
          "Grep",
          "Skill",
        ],
        permissionMode: "bypassPermissions",
        mcpServers: mcpServers as Record<string, never>,
        hooks: hooks as Record<string, never>,
        settingSources: ["project"],
        maxTurns: 50,
        resume: task.agent_session_id!,
        abortController,
      },
    })) {
      this.handleMessage(task.id, message);
      if (message.type === "result" && "result" in message) {
        result = (message as { result: string }).result;
      }
    }

    return result;
  }

  private handleMessage(
    taskId: string,
    message: Record<string, unknown>
  ): void {
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

    if (message.type === "result") {
      const totalCost = (
        message as { total_cost_usd?: number }
      ).total_cost_usd;
      if (totalCost !== undefined && totalCost > 0) {
        const withinBudget = recordCost(
          this.ctx.daemonId,
          totalCost
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
