import { createHash } from "node:crypto";
import {
  insertEvent,
  updateTaskSessionId,
  isQuestionAsked,
  recordQuestionHash,
} from "../db/queries.js";
import { createLogger } from "../shared/logger.js";
import type { DaemonContext } from "../shared/types.js";

const log = createLogger("hooks");

/**
 * Build SDK hook callbacks for a specific task.
 * Hooks are pure — side effects are only DB writes.
 */
export function buildHooks(ctx: DaemonContext, taskId: string) {
  return {
    async PostToolUse(input: {
      tool_name?: string;
      tool_input?: Record<string, unknown>;
      tool_result?: string;
    }) {
      const toolName = input.tool_name ?? "";

      // Track file changes from Edit/Write tools
      if (toolName === "Edit" || toolName === "Write") {
        const filePath =
          (input.tool_input?.["file_path"] as string) ??
          (input.tool_input?.["path"] as string) ??
          "unknown";
        insertEvent({
          daemonId: ctx.daemonId,
          taskId,
          type: "file_changed",
          payload: { tool: toolName, file: filePath },
        });
      }

      // Detect duplicate questions
      if (toolName === "AskUserQuestion") {
        const questions = input.tool_input?.["questions"] as Array<{
          question: string;
        }>;
        if (questions && questions.length > 0) {
          const questionText = JSON.stringify(questions);
          const questionHash = createHash("sha256")
            .update(questionText)
            .digest("hex")
            .slice(0, 16);

          const isDuplicate = isQuestionAsked(taskId, questionHash);
          if (isDuplicate) {
            log.warn("Duplicate question detected", {
              taskId,
              questionHash,
              questionCount: questions.length,
            });
            insertEvent({
              daemonId: ctx.daemonId,
              taskId,
              type: "duplicate_question",
              payload: { hash: questionHash, questionCount: questions.length },
            });
          } else {
            recordQuestionHash(taskId, questionHash);
            log.debug("Question recorded", {
              taskId,
              questionHash,
              questionCount: questions.length,
            });
          }
        }
      }

      return {};
    },

    async Stop(input: { reason?: string; result?: string }) {
      log.debug("Agent stopped", { taskId, reason: input.reason });
      insertEvent({
        daemonId: ctx.daemonId,
        taskId,
        type: "agent_stop",
        payload: { reason: input.reason },
      });
      return {};
    },
  };
}

/**
 * Extract and store session_id from an SDK init message.
 */
export function handleInitMessage(
  taskId: string,
  message: { session_id?: string }
): void {
  if (message.session_id) {
    updateTaskSessionId(taskId, message.session_id);
    log.debug("Stored session ID", { taskId, sessionId: message.session_id });
  }
}
