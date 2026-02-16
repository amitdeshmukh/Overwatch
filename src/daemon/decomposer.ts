import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../shared/logger.js";
import { getSkillManifest, getSkillLibraryPath } from "../skills/library.js";
import { finishDecompositionRun, insertAgentTrace, startDecompositionRun } from "../db/queries.js";
import type {
  DecomposedTask,
  AgentModel,
} from "../shared/types.js";

const log = createLogger("decomposer");

export type DecompositionFailureCode =
  | "timeout"
  | "aborted"
  | "provider"
  | "unknown";

export class DecompositionError extends Error {
  readonly code: DecompositionFailureCode;
  readonly technicalMessage: string;
  readonly userMessage: string;
  readonly elapsedMs: number;

  constructor(params: {
    code: DecompositionFailureCode;
    technicalMessage: string;
    userMessage: string;
    elapsedMs: number;
  }) {
    super(params.technicalMessage);
    this.name = "DecompositionError";
    this.code = params.code;
    this.technicalMessage = params.technicalMessage;
    this.userMessage = params.userMessage;
    this.elapsedMs = params.elapsedMs;
  }
}

const DECOMPOSE_PROMPT_BASE = `You are a task decomposer. Given a user request, break it down into focused subtasks that can each be completed by a single agent session.

For each subtask, provide:
- title: short descriptive name
- prompt: detailed instructions (include file paths, function names, acceptance criteria)
- model: one of "haiku", "sonnet", "opus" — choose based on task complexity:
  - "haiku": ONLY for non-coding tasks (file renaming, formatting, grep-and-replace, simple lookups, file operations, shell/CLI commands). NEVER use haiku for any task that involves writing or modifying code.
  - "sonnet": standard coding tasks (implementation, API endpoints, tests, refactoring, integrations, code generation)
  - "opus": complex reasoning (architecture decisions, security audits, performance optimization, debugging subtle issues, multi-system design)
- skills: array of skill names from the available skills list below (can be empty if no skills are relevant)
- capability_id: optional capability identifier (usually a skill name). Use "general" if no specialized capability is needed.
- deps: array of titles of other subtasks this depends on (empty if independent)

Guidelines:
- Each subtask should be completable in under 20 agent messages
- Maximize parallelism — only add dependencies when truly required
- Be specific in prompts so the agent can work without further context
- Include a final "review" or "integrate" task if the work needs synthesis
- Default to "sonnet" when unsure. Only use "haiku" for non-coding file operations — never for tasks that write or modify code. Reserve "opus" for tasks that genuinely need advanced reasoning.
- Assign skills that are genuinely useful for the subtask. Most subtasks need zero or one skill. If a specialized skill handles the task (like nanobanana for image generation), you MUST assign it.
- If a subtask requires analyzing very large logs/documents/transcripts, set capability_id to "long-context-analysis".

Respond ONLY with a JSON array. No markdown fences, no explanation.`;

function buildDecomposePrompt(): string {
  const manifest = getSkillManifest();

  let skillSection = "";
  if (manifest.length > 0) {
    const skillList = manifest
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");

    skillSection = `\n\n## Available Skills (Inject these into subtasks when relevant)\n\nConsider using these specialized skills to handle specific task types:\n\n${skillList}`;
  }

  return DECOMPOSE_PROMPT_BASE + skillSection;
}

const VALID_MODELS = new Set<AgentModel>(["haiku", "sonnet", "opus"]);
const DECOMPOSE_MODEL = "claude-opus-4-6";
const DECOMPOSE_MAX_TURNS = 3;

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function classifyDecompositionFailure(
  err: unknown,
  timedOut: boolean,
  elapsedMs: number
): DecompositionError {
  const raw = errorText(err);
  const normalized = raw.toLowerCase();

  if (timedOut) {
    return new DecompositionError({
      code: "timeout",
      technicalMessage: `Decomposition timed out after ${DECOMPOSE_TIMEOUT_MS}ms`,
      userMessage: `Planning timed out after ${Math.round(
        DECOMPOSE_TIMEOUT_MS / 1000
      )}s. No subtasks were started.`,
      elapsedMs,
    });
  }

  if (
    normalized.includes("aborted by user") ||
    normalized.includes("aborterror") ||
    normalized.includes("aborted")
  ) {
    return new DecompositionError({
      code: "aborted",
      technicalMessage: `Decomposition aborted before completion: ${raw}`,
      userMessage: "Planning was interrupted before completion. No subtasks were started.",
      elapsedMs,
    });
  }

  if (
    normalized.includes("rate limit") ||
    normalized.includes("overloaded") ||
    normalized.includes("timeout") ||
    normalized.includes("503") ||
    normalized.includes("502") ||
    normalized.includes("429")
  ) {
    return new DecompositionError({
      code: "provider",
      technicalMessage: `Model/provider error during decomposition: ${raw}`,
      userMessage: "Planning failed due to a model/provider error. No subtasks were started.",
      elapsedMs,
    });
  }

  return new DecompositionError({
    code: "unknown",
    technicalMessage: `Unexpected decomposition error: ${raw}`,
    userMessage: "Planning failed before execution started.",
    elapsedMs,
  });
}

/**
 * Load SKILL.md content for each skill and append it to the subtask prompt.
 * This ensures the agent sees skill instructions directly in its prompt
 * rather than relying on passive .claude/skills/ file discovery.
 */
function enrichPromptWithSkills(prompt: string, skills: string[]): string {
  if (skills.length === 0) return prompt;

  const sections: string[] = [];
  for (const name of skills) {
    const skillDir = getSkillLibraryPath(name);
    const skillMdPath = resolve(skillDir, "SKILL.md");
    try {
      const content = readFileSync(skillMdPath, "utf-8");
      sections.push(content);
    } catch {
      log.warn("Could not load skill content for prompt enrichment", { skill: name });
    }
  }

  if (sections.length === 0) return prompt;
  return `${prompt}\n\n## Skill Instructions\n\nYou MUST follow these skill instructions to complete the task:\n\n${sections.join("\n\n---\n\n")}`;
}

/** Timeout for decomposition (2 minutes) */
const DECOMPOSE_TIMEOUT_MS = 120_000;

export async function decompose(
  userRequest: string,
  workdir: string,
  context?: {
    daemonId?: string;
    taskId?: string;
  }
): Promise<DecomposedTask[]> {
  const startedAt = Date.now();
  log.info("Decomposing request", {
    request: userRequest.slice(0, 100),
  });

  const prompt = `${buildDecomposePrompt()}\n\nUser request:\n${userRequest}`;
  const runId =
    context?.daemonId
      ? startDecompositionRun({
          daemonId: context.daemonId,
          taskId: context.taskId,
          model: DECOMPOSE_MODEL,
          timeoutMs: DECOMPOSE_TIMEOUT_MS,
          maxTurns: DECOMPOSE_MAX_TURNS,
          requestChars: userRequest.length,
          promptChars: prompt.length,
        })
      : null;

  if (context?.daemonId) {
    insertAgentTrace({
      daemonId: context.daemonId,
      taskId: context.taskId ?? null,
      source: "daemon",
      eventType: "decomposition_started",
      payload: {
        model: DECOMPOSE_MODEL,
        timeoutMs: DECOMPOSE_TIMEOUT_MS,
        maxTurns: DECOMPOSE_MAX_TURNS,
        requestChars: userRequest.length,
        promptChars: prompt.length,
      },
    });
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      abortController.abort();
    },
    DECOMPOSE_TIMEOUT_MS
  );

  let result = "";
  try {
    for await (const message of query({
      prompt,
      options: {
        model: DECOMPOSE_MODEL,
        cwd: workdir,
        allowedTools: ["Read", "Glob", "Grep"],
        maxTurns: DECOMPOSE_MAX_TURNS,
        permissionMode: "bypassPermissions",
        abortController,
      },
    })) {
      if (message.type === "result" && "result" in message) {
        result = (message as { result: string }).result;
      }
    }
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const classified = classifyDecompositionFailure(err, timedOut, elapsedMs);
    log.error("Decomposition query failed", {
      code: classified.code,
      elapsedMs: classified.elapsedMs,
      timeoutMs: DECOMPOSE_TIMEOUT_MS,
      technical: classified.technicalMessage,
      requestChars: userRequest.length,
      promptChars: prompt.length,
    });
    if (runId) {
      finishDecompositionRun({
        id: runId,
        status: "failed",
        elapsedMs: classified.elapsedMs,
        resultChars: result.length,
        parseAttempts: 1,
        fallbackUsed: false,
        errorCode: classified.code,
        technicalMessage: classified.technicalMessage,
        rawResultExcerpt: result.slice(0, 1200),
      });
    }
    if (context?.daemonId) {
      insertAgentTrace({
        daemonId: context.daemonId,
        taskId: context.taskId ?? null,
        source: "daemon",
        eventType: "decomposition_failed",
        payload: {
          code: classified.code,
          elapsedMs: classified.elapsedMs,
          timeoutMs: DECOMPOSE_TIMEOUT_MS,
          requestChars: userRequest.length,
          promptChars: prompt.length,
          resultChars: result.length,
          technical: classified.technicalMessage,
        },
      });
    }
    throw classified;
  } finally {
    clearTimeout(timeout);
  }

  try {
    const tasks = parseDecomposition(result);
    const elapsedMs = Date.now() - startedAt;
    log.info("Decomposed into subtasks", {
      count: tasks.length,
      models: tasks.map((t) => `${t.title}:${t.model}`),
    });
    if (runId) {
      finishDecompositionRun({
        id: runId,
        status: "success",
        elapsedMs,
        resultChars: result.length,
        parseAttempts: 1,
        fallbackUsed: false,
        rawResultExcerpt: result.slice(0, 1200),
      });
    }
    if (context?.daemonId) {
      insertAgentTrace({
        daemonId: context.daemonId,
        taskId: context.taskId ?? null,
        source: "daemon",
        eventType: "decomposition_succeeded",
        payload: {
          elapsedMs,
          subtaskCount: tasks.length,
          requestChars: userRequest.length,
          promptChars: prompt.length,
          resultChars: result.length,
          parseAttempts: 1,
          fallbackUsed: false,
        },
      });
    }
    return tasks;
  } catch (err) {
    log.warn("First decomposition parse failed, retrying", {
      error: String(err),
    });
    if (context?.daemonId) {
      insertAgentTrace({
        daemonId: context.daemonId,
        taskId: context.taskId ?? null,
        source: "daemon",
        eventType: "decomposition_parse_failed_first",
        payload: {
          error: String(err),
          resultChars: result.length,
        },
      });
    }
    if (context?.daemonId) {
      insertAgentTrace({
        daemonId: context.daemonId,
        taskId: context.taskId ?? null,
        source: "daemon",
        eventType: "decomposition_parse_retry_started",
        payload: {},
      });
    }
    try {
      const retry = await retryDecomposition(result, workdir);
      const tasks = retry.tasks;
      const elapsedMs = Date.now() - startedAt;
      if (runId) {
        finishDecompositionRun({
          id: runId,
          status: "success",
          elapsedMs,
          resultChars: retry.raw.length,
          parseAttempts: 2,
          fallbackUsed: false,
          rawResultExcerpt: retry.raw.slice(0, 1200),
        });
      }
      if (context?.daemonId) {
        insertAgentTrace({
          daemonId: context.daemonId,
          taskId: context.taskId ?? null,
          source: "daemon",
          eventType: "decomposition_succeeded",
          eventSubtype: "retry_parse",
          payload: {
            elapsedMs,
            subtaskCount: tasks.length,
            requestChars: userRequest.length,
            promptChars: prompt.length,
            resultChars: retry.raw.length,
            parseAttempts: 2,
            fallbackUsed: false,
          },
        });
      }
      return tasks;
    } catch (retryErr) {
      log.error("Retry decomposition parse failed, using single-task fallback", {
        error: String(retryErr),
      });
      if (context?.daemonId) {
        insertAgentTrace({
          daemonId: context.daemonId,
          taskId: context.taskId ?? null,
          source: "daemon",
          eventType: "decomposition_parse_retry_failed",
          payload: { error: String(retryErr) },
        });
      }
      const elapsedMs = Date.now() - startedAt;
      const fallbackTask = buildFallbackTask(userRequest);
      const fallbackMessage =
        `Initial parse error: ${String(err)} | Retry parse error: ${String(retryErr)}`;
      if (runId) {
        finishDecompositionRun({
          id: runId,
          status: "success",
          elapsedMs,
          resultChars: result.length,
          parseAttempts: 2,
          fallbackUsed: true,
          technicalMessage: fallbackMessage,
          rawResultExcerpt: result.slice(0, 1200),
        });
      }
      if (context?.daemonId) {
        insertAgentTrace({
          daemonId: context.daemonId,
          taskId: context.taskId ?? null,
          source: "daemon",
          eventType: "decomposition_fallback_single_task",
          payload: {
            elapsedMs,
            requestChars: userRequest.length,
            promptChars: prompt.length,
            resultChars: result.length,
            parseAttempts: 2,
            fallbackUsed: true,
            initialParseError: String(err),
            retryParseError: String(retryErr),
          },
        });
      }
      return [fallbackTask];
    }
  }
}

async function retryDecomposition(
  badOutput: string,
  workdir: string
): Promise<{ tasks: DecomposedTask[]; raw: string }> {
  const fixPrompt = `The previous decomposition output was malformed JSON. Here it is:

${badOutput}

Please fix it and return ONLY a valid JSON array of subtasks with title, prompt, model, skills, capability_id, deps fields. No markdown fences.`;

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    60_000
  );

  let result = "";
  try {
    for await (const message of query({
      prompt: fixPrompt,
      options: {
        model: "claude-opus-4-6",
        cwd: workdir,
        allowedTools: [],
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        abortController,
      },
    })) {
      if (message.type === "result" && "result" in message) {
        result = (message as { result: string }).result;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    tasks: parseDecomposition(result),
    raw: result,
  };
}

function parseDecomposition(raw: string): DecomposedTask[] {
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Decomposition result is not an array");
  }

  return parsed.map((itemRaw: unknown) => {
    const item =
      itemRaw && typeof itemRaw === "object"
        ? (itemRaw as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const model = String(item.model ?? "sonnet");
    const skills = Array.isArray(item.skills) ? item.skills.map(String) : [];
    const rawPrompt = String(item.prompt ?? "");
    return {
      title: String(item.title ?? "Untitled"),
      prompt: enrichPromptWithSkills(rawPrompt, skills),
      exec_mode: "auto" as const,
      model: (VALID_MODELS.has(model as AgentModel)
        ? model
        : "sonnet") as AgentModel,
      deps: Array.isArray(item.deps) ? item.deps.map(String) : [],
      skills,
      capability_id: typeof item.capability_id === "string" ? item.capability_id : undefined,
    };
  });
}

function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();

  // 1) direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // continue
  }

  // 2) fenced parse
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  // 3) bracket extraction parse
  const start = trimmed.indexOf("[");
  if (start === -1) {
    throw new Error("No JSON array found in decomposition output");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0) {
      const slice = trimmed.slice(start, i + 1);
      const parsed = JSON.parse(slice);
      if (!Array.isArray(parsed)) {
        throw new Error("Extracted JSON is not an array");
      }
      return parsed;
    }
  }

  throw new Error("Unterminated JSON array in decomposition output");
}

function buildFallbackTask(userRequest: string): DecomposedTask {
  return {
    title: "Execute user request",
    prompt: userRequest,
    exec_mode: "auto",
    model: "sonnet",
    deps: [],
    skills: [],
    capability_id: undefined,
  };
}
