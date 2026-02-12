import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../shared/logger.js";
import { getSkillManifest } from "../skills/library.js";
import type {
  DecomposedTask,
  AgentModel,
} from "../shared/types.js";

const log = createLogger("decomposer");

const DECOMPOSE_PROMPT_BASE = `You are a task decomposer. Given a user request, break it down into focused subtasks that can each be completed by a single agent session.

For each subtask, provide:
- title: short descriptive name
- prompt: detailed instructions (include file paths, function names, acceptance criteria)
- model: one of "haiku", "sonnet", "opus" — choose based on task complexity:
  - "haiku": simple/mechanical tasks (file renaming, formatting, grep-and-replace, boilerplate generation, simple lookups)
  - "sonnet": standard implementation (most coding tasks, API endpoints, tests, refactoring, integrations)
  - "opus": complex reasoning (architecture decisions, security audits, performance optimization, debugging subtle issues, multi-system design)
- skills: array of skill names from the available skills list below (can be empty if no skills are relevant)
- deps: array of titles of other subtasks this depends on (empty if independent)

Guidelines:
- Each subtask should be completable in under 20 agent messages
- Maximize parallelism — only add dependencies when truly required
- Be specific in prompts so the agent can work without further context
- Include a final "review" or "integrate" task if the work needs synthesis
- Default to "sonnet" when unsure. Use "haiku" aggressively for simple work to save cost. Reserve "opus" for tasks that genuinely need advanced reasoning.
- Assign skills that are genuinely useful for the subtask. Most subtasks need zero or one skill. If a specialized skill handles the task (like nanobanana for image generation), you MUST assign it.

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

/** Timeout for decomposition (2 minutes) */
const DECOMPOSE_TIMEOUT_MS = 120_000;

export async function decompose(
  userRequest: string,
  workdir: string
): Promise<DecomposedTask[]> {
  log.info("Decomposing request", {
    request: userRequest.slice(0, 100),
  });

  const prompt = `${buildDecomposePrompt()}\n\nUser request:\n${userRequest}`;
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    DECOMPOSE_TIMEOUT_MS
  );

  let result = "";
  try {
    for await (const message of query({
      prompt,
      options: {
        model: "claude-opus-4-6",
        cwd: workdir,
        allowedTools: ["Read", "Glob", "Grep"],
        maxTurns: 3,
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

  try {
    const tasks = parseDecomposition(result);
    log.info("Decomposed into subtasks", {
      count: tasks.length,
      models: tasks.map((t) => `${t.title}:${t.model}`),
    });
    return tasks;
  } catch (err) {
    log.warn("First decomposition parse failed, retrying", {
      error: String(err),
    });
    return retryDecomposition(result, workdir);
  }
}

async function retryDecomposition(
  badOutput: string,
  workdir: string
): Promise<DecomposedTask[]> {
  const fixPrompt = `The previous decomposition output was malformed JSON. Here it is:

${badOutput}

Please fix it and return ONLY a valid JSON array of subtasks with title, prompt, role, model, skills, deps fields. No markdown fences.`;

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

  return parseDecomposition(result);
}

function parseDecomposition(raw: string): DecomposedTask[] {
  let jsonStr = raw.trim();

  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) {
    throw new Error("Decomposition result is not an array");
  }

  return parsed.map((item: Record<string, unknown>) => {
    const model = String(item.model ?? "sonnet");
    return {
      title: String(item.title ?? "Untitled"),
      prompt: String(item.prompt ?? ""),
      exec_mode: "auto" as const,
      model: (VALID_MODELS.has(model as AgentModel)
        ? model
        : "sonnet") as AgentModel,
      deps: Array.isArray(item.deps) ? item.deps.map(String) : [],
      skills: Array.isArray(item.skills) ? item.skills.map(String) : [],
    };
  });
}
