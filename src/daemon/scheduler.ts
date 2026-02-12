import {
  getPendingTasks,
  getRunningTasks,
  getTask,
  getChildTasks,
  updateTaskStatus,
  updateTaskResult,
  failTask,
  resetTaskToPending,
  promoteUnblockedTasks,
  areChildrenDone,
  hasChildrenFailed,
  insertEvent,
  updateDaemonStatus,
  updateDaemonHeartbeat,
  getRootTask,
  createTasksBatch,
  updateTaskDepsBatch,
  getPendingCommands,
  markCommandHandled,
} from "../db/queries.js";
import { decompose } from "./decomposer.js";
import { AgentPool } from "./agent-pool.js";
import { isBudgetExceeded } from "./budget.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import {
  parseTaskResult,
} from "../shared/types.js";
import type {
  DaemonContext,
  TaskRow,
  TaskStatus,
  TaskResult,
  TaskResultAggregate,
  CommandRow,
} from "../shared/types.js";

const log = createLogger("scheduler");

const MAX_CONSECUTIVE_ERRORS = 3;

export class Scheduler {
  private ctx: DaemonContext;
  private pool: AgentPool;
  private running = false;
  private paused = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveErrors = 0;
  private pendingNotifications = 0;

  /** Callback to send a Telegram message to the user */
  sendMessage: ((text: string) => Promise<void>) | null = null;

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
    this.pool = new AgentPool(ctx);
  }

  async start(): Promise<void> {
    this.running = true;
    this.paused = false;
    updateDaemonStatus(this.ctx.daemonId, "running");
    log.info("Scheduler started", { daemon: this.ctx.daemonName });

    await this.tick();
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => {
        this.consecutiveErrors++;
        log.error("Tick error", {
          error: String(err),
          consecutive: this.consecutiveErrors,
        });
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log.error(
            "Too many consecutive errors, marking daemon as error and exiting"
          );
          updateDaemonStatus(this.ctx.daemonId, "error");
          this.stop();
          // Exit the process so manager can detect and decide
          process.exit(1);
        }
      });
    }, config.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pool.killAll();
    log.info("Scheduler stopped", { daemon: this.ctx.daemonName });
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.pool.drain();
    log.info("Scheduler drained and shut down", {
      daemon: this.ctx.daemonName,
    });
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const { daemonId } = this.ctx;

    // Heartbeat
    updateDaemonHeartbeat(daemonId);

    // 1. Process pending commands from bot
    await this.processCommands();

    if (!this.running) return; // kill command may have stopped us

    // Don't spawn new work if paused
    if (this.paused) return;

    // Don't spawn new work if budget exceeded
    if (isBudgetExceeded(daemonId)) {
      log.warn("Budget exceeded, not spawning new agents");
      return;
    }

    // 2. Check if root task needs decomposition
    const root = getRootTask(daemonId);
    if (root && root.status === "pending") {
      await this.decomposeRoot(root);
      this.consecutiveErrors = 0;
      return;
    }

    // 3. Promote blocked tasks whose deps are now resolved
    const promoted = promoteUnblockedTasks(daemonId);
    if (promoted.length > 0) {
      log.info("Promoted tasks", {
        count: promoted.length,
        titles: promoted.map((t) => t.title),
      });
    }

    // 4. Spawn agents for pending tasks (up to concurrency limit)
    const pending = getPendingTasks(daemonId);
    const slotsAvailable =
      config.maxAgentsPerDaemon - this.pool.runningCount;

    for (const task of pending.slice(0, slotsAvailable)) {
      // Skip root tasks that have children (they get decomposed, not executed)
      if (!task.parent_id && getChildTasks(task.id).length > 0) {
        continue;
      }

      // Update status before spawn — but catch spawn errors
      updateTaskStatus(task.id, "running");
      insertEvent({
        daemonId,
        taskId: task.id,
        type: "task_started",
      });

      try {
        this.pool.spawn(
          { ...task, status: "running" },
          (taskId, result) => this.onAgentComplete(taskId, result),
          (taskId, error) => this.onAgentError(taskId, error)
        );
      } catch (err) {
        // Issue #21: revert status if spawn fails
        log.error("Failed to spawn agent", {
          taskId: task.id,
          error: String(err),
        });
        failTask(task.id, `Spawn failed: ${err}`);
      }
    }

    // 5. Check if all work is done
    if (pending.length === 0 && this.pool.runningCount === 0 && this.pendingNotifications === 0) {
      const rootTask = getRootTask(daemonId);
      if (rootTask && rootTask.status === "done") {
        updateDaemonStatus(daemonId, "idle");
        // Child results already notified individually — no need to re-send
        this.stop();
      }
    }

    this.consecutiveErrors = 0;
  }

  private async processCommands(): Promise<void> {
    const commands = getPendingCommands(this.ctx.daemonId);

    for (const cmd of commands) {
      try {
        await this.handleCommand(cmd);
      } catch (err) {
        log.error("Failed to handle command", {
          commandId: cmd.id,
          type: cmd.type,
          error: String(err),
        });
      }
      markCommandHandled(cmd.id);
    }
  }

  private async handleCommand(cmd: CommandRow): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(cmd.payload) as Record<string, unknown>;
    } catch {
      log.error("Malformed command payload", {
        commandId: cmd.id,
        raw: cmd.payload,
      });
      return;
    }

    switch (cmd.type) {
      case "answer": {
        const taskId =
          typeof payload.taskId === "string" ? payload.taskId : null;
        const text =
          typeof payload.text === "string" ? payload.text : null;
        if (!taskId || !text) {
          log.warn("Invalid answer command payload", { payload });
          return;
        }
        const task = getTask(taskId);
        if (task && task.agent_session_id) {
          updateTaskStatus(task.id, "running");
          this.pool.resumeAgent(
            task,
            text,
            (tid, result) => this.onAgentComplete(tid, result),
            (tid, error) => this.onAgentError(tid, error)
          );
        }
        break;
      }

      case "kill": {
        log.info("Kill command received");
        const running = getRunningTasks(this.ctx.daemonId);
        for (const task of running) {
          this.pool.kill(task.id);
          failTask(task.id, "Killed by user");
        }
        updateDaemonStatus(this.ctx.daemonId, "idle");
        this.stop();
        // Signal process to exit
        process.kill(process.pid, "SIGTERM");
        break;
      }

      case "pause": {
        log.info("Pause command received");
        this.paused = true;
        break;
      }

      case "resume": {
        log.info("Resume command received");
        this.paused = false;
        break;
      }

      case "retry": {
        const taskId =
          typeof payload.taskId === "string" ? payload.taskId : null;
        if (!taskId) {
          log.warn("Invalid retry command payload", { payload });
          return;
        }
        const task = getTask(taskId);
        if (task && task.status === "failed") {
          resetTaskToPending(task.id);
          log.info("Retrying task", {
            taskId,
            title: task.title,
          });

          if (task.parent_id) {
            const parent = getTask(task.parent_id);
            if (parent && parent.status === "failed") {
              // Direct DB update since "failed" → "running" isn't in normal transitions
              const db = (await import("../db/index.js")).getDb();
              db.prepare(
                `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`
              ).run(parent.id);
            }
          }
        }
        break;
      }
    }
  }

  private async decomposeRoot(root: TaskRow): Promise<void> {
    log.info("Decomposing root task", { title: root.title });
    updateTaskStatus(root.id, "running");

    try {
      const subtasks = await decompose(root.prompt, this.ctx.workdir);

      if (subtasks.length === 0) {
        // Simple task — run directly, with fallback if spawn fails
        log.info("No subtasks, running root directly");
        try {
          this.pool.spawn(
            { ...root, status: "running" },
            (taskId, result) => this.onAgentComplete(taskId, result),
            (taskId, error) => this.onAgentError(taskId, error)
          );
        } catch (err) {
          failTask(root.id, `Spawn failed: ${err}`);
        }
        return;
      }

      // Issue #5: Create all subtasks in a single transaction
      const createdTasks = createTasksBatch(
        subtasks.map((sub) => ({
          daemonId: this.ctx.daemonId,
          parentId: root.id,
          title: sub.title,
          prompt: sub.prompt,
          execMode: sub.exec_mode,
          agentModel: sub.model,
          deps: [],
          skills: sub.skills,
        }))
      );

      // Build title → ID map
      const titleToId = new Map<string, string>();
      for (let i = 0; i < subtasks.length; i++) {
        titleToId.set(subtasks[i].title, createdTasks[i].id);
      }

      // Resolve deps and update in a batch transaction
      const depUpdates: Array<{
        taskId: string;
        deps: string[];
        status: TaskStatus;
      }> = [];

      for (let i = 0; i < subtasks.length; i++) {
        const sub = subtasks[i];
        if (sub.deps.length > 0) {
          const depIds = sub.deps
            .map((depTitle) => titleToId.get(depTitle))
            .filter((id): id is string => id !== undefined);

          if (depIds.length > 0) {
            depUpdates.push({
              taskId: createdTasks[i].id,
              deps: depIds,
              status: "blocked",
            });
          }
        }
      }

      if (depUpdates.length > 0) {
        updateTaskDepsBatch(depUpdates);
      }

      log.info("Created subtasks", {
        count: subtasks.length,
        titles: subtasks.map((s) => s.title),
      });
    } catch (err) {
      log.error("Decomposition failed", { error: String(err) });
      failTask(root.id, `Decomposition failed: ${err}`);
      await this.notify(
        `Decomposition failed for "${this.ctx.daemonName}": ${err}`
      );
    }
  }

  private onAgentComplete(taskId: string, result: string): void {
    // Result is guaranteed to be TaskResult JSON (coerced in agent-pool)
    const parsed = parseTaskResult(result);
    if (!parsed) {
      log.warn("Agent returned invalid TaskResult, this should not happen", { taskId });
    }

    updateTaskResult(taskId, result);
    insertEvent({
      daemonId: this.ctx.daemonId,
      taskId,
      type: "task_done",
      payload: {
        resultLength: result.length,
        status: parsed?.status ?? "unknown",
      },
    });

    // Send result to Telegram — wait for formatting + image send before proceeding to shutdown
    this.notify(result).then(() => {
      const task = getTask(taskId);
      if (task?.parent_id) {
        this.checkParentCompletion(task.parent_id);
      }
    }).catch(() => {
      // Still complete parent even if notify fails
      const task = getTask(taskId);
      if (task?.parent_id) {
        this.checkParentCompletion(task.parent_id);
      }
    });
  }

  private onAgentError(taskId: string, error: Error): void {
    failTask(taskId, error.message);
    insertEvent({
      daemonId: this.ctx.daemonId,
      taskId,
      type: "task_failed",
      payload: { error: error.message },
    });

    const task = getTask(taskId);
    this.notify(
      `Task "${task?.title ?? taskId}" failed: ${error.message}`
    ).catch(() => {});

    if (task?.parent_id) {
      if (hasChildrenFailed(task.parent_id)) {
        const parent = getTask(task.parent_id);
        if (parent && parent.status === "running") {
          failTask(parent.id, "One or more subtasks failed");
        }
      }
    }
  }

  private checkParentCompletion(parentId: string): void {
    if (areChildrenDone(parentId)) {
      const children = getChildTasks(parentId);

      // Aggregate child TaskResults into TaskResultAggregate
      const aggregate: TaskResultAggregate = [];
      for (const c of children) {
        const parsed = parseTaskResult(c.result ?? "");
        if (parsed) {
          aggregate.push({ title: c.title, result: parsed });
        } else {
          // Child didn't have valid TaskResult — wrap it
          aggregate.push({
            title: c.title,
            result: {
              status: "success",
              message: (c.result ?? "").split("\n")[0].slice(0, 500),
            },
          });
        }
      }

      const parentResult = JSON.stringify(aggregate);
      updateTaskResult(parentId, parentResult);
      log.info("Parent task completed", { parentId, childCount: aggregate.length });

      const parent = getTask(parentId);
      if (parent?.parent_id) {
        this.checkParentCompletion(parent.parent_id);
      }
    }
  }

  private async notify(message: string): Promise<void> {
    log.info("Notification", { message: message.slice(0, 200) });
    if (this.sendMessage) {
      this.pendingNotifications++;
      try {
        await this.sendMessage(message);
      } catch (err) {
        log.error("Failed to send Telegram message", {
          error: String(err),
        });
      } finally {
        this.pendingNotifications--;
      }
    }
  }

  killTask(taskId: string): boolean {
    const killed = this.pool.kill(taskId);
    if (killed) {
      failTask(taskId, "Killed by user");
      insertEvent({
        daemonId: this.ctx.daemonId,
        taskId,
        type: "task_failed",
        payload: { reason: "killed" },
      });
    }
    return killed;
  }
}
