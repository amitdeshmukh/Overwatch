import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseTaskResult, type TaskRow } from "../shared/types.js";

const MAX_FILES = 60;
const MAX_SOURCE_BYTES = 1_500_000;
const MAX_FILE_BYTES = 200_000;
const CHUNK_CHARS = 12_000;
const MAX_LLM_CALLS = 20;
const GROUP_SIZE = 5;

const TEXT_FILE_EXT = new Set([
  ".txt",
  ".md",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".js",
  ".ts",
  ".py",
  ".sql",
]);

function isLikelyText(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of TEXT_FILE_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function scanTextFiles(rootDir: string): string[] {
  const out: string[] = [];
  const skipDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    ".claude",
    ".overwatch",
    "__pycache__",
    ".venv",
    "venv",
  ]);

  const stack = [rootDir];
  while (stack.length > 0 && out.length < MAX_FILES * 2) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isLikelyText(entry.name)) out.push(fullPath);
      if (out.length >= MAX_FILES * 2) break;
    }
  }

  return out.slice(0, MAX_FILES);
}

function readSources(rootDir: string): string[] {
  const files = scanTextFiles(rootDir);
  const docs: string[] = [];
  let totalBytes = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    if (content.includes("\u0000")) continue;
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES);
    }

    const bytes = Buffer.byteLength(content, "utf-8");
    if (totalBytes + bytes > MAX_SOURCE_BYTES) break;
    totalBytes += bytes;
    docs.push(`FILE: ${relative(rootDir, file)}\n${content}`);
    if (docs.length >= MAX_FILES) break;
  }

  return docs;
}

function chunkText(items: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const item of items) {
    if ((cur + "\n\n" + item).length > maxChars && cur.length > 0) {
      chunks.push(cur);
      cur = item;
    } else {
      cur = cur ? `${cur}\n\n${item}` : item;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function oneShot(
  prompt: string,
  model: string,
  cwd: string,
  abortController: AbortController
): Promise<{ result: string; costUsd: number }> {
  let result = "";
  let costUsd = 0;
  for await (const message of query({
    prompt,
    options: {
      model,
      cwd,
      allowedTools: [],
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      abortController,
    },
  })) {
    if (message.type === "result" && "result" in message) {
      result = (message as { result: string }).result;
      costUsd += (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
    }
  }
  return { result, costUsd };
}

export async function runRlmStyleAnalysis(params: {
  task: TaskRow;
  workdir: string;
  model: string;
  abortController: AbortController;
}): Promise<{ rawResult: string; totalCostUsd: number }> {
  const { task, workdir, model, abortController } = params;

  let llmCalls = 0;
  let totalCostUsd = 0;

  const sources = readSources(workdir);
  if (sources.length === 0) {
    const fallback = JSON.stringify({
      status: "success",
      message: "No large local corpus found. Analyzed request text only.",
      data: {
        capability: "long-context-analysis",
        llm_calls: 0,
        analyzed_files: 0,
      },
    });
    return { rawResult: fallback, totalCostUsd: 0 };
  }

  const chunks = chunkText(sources, CHUNK_CHARS);
  const chunkFindings: string[] = [];

  for (let i = 0; i < chunks.length && llmCalls < MAX_LLM_CALLS; i++) {
    const { result, costUsd } = await oneShot(
      `You are analyzing one shard of a large corpus.
Objective:
${task.prompt}

Shard ${i + 1}/${chunks.length}:
${chunks[i]}

Return concise findings relevant to the objective. 6 bullet points max.`,
      model,
      workdir,
      abortController
    );
    llmCalls++;
    totalCostUsd += costUsd;
    chunkFindings.push(result.trim());
  }

  let layer = chunkFindings;
  while (layer.length > 1 && llmCalls < MAX_LLM_CALLS) {
    const grouped = chunkText(layer, CHUNK_CHARS).slice(0, GROUP_SIZE);
    const nextLayer: string[] = [];
    for (let i = 0; i < grouped.length && llmCalls < MAX_LLM_CALLS; i++) {
      const { result, costUsd } = await oneShot(
        `Synthesize these intermediate findings for objective:
${task.prompt}

Findings batch:
${grouped[i]}

Return distilled insights only.`,
        model,
        workdir,
        abortController
      );
      llmCalls++;
      totalCostUsd += costUsd;
      nextLayer.push(result.trim());
    }
    layer = nextLayer.length > 0 ? nextLayer : layer.slice(0, 1);
  }

  const synthesis = layer[0] ?? "No synthesis generated.";
  const { result: finalRaw, costUsd: finalCost } = await oneShot(
    `Return ONLY JSON matching:
{"status":"success|error","message":"string","data":{"summary":"string","llm_calls":number,"analyzed_files":number}}

Objective:
${task.prompt}

Synthesis:
${synthesis}`,
    model,
    workdir,
    abortController
  );
  llmCalls++;
  totalCostUsd += finalCost;

  const parsed = parseTaskResult(finalRaw);
  if (!parsed) {
    const safe = JSON.stringify({
      status: "success",
      message: "Long-context analysis completed.",
      data: {
        capability: "long-context-analysis",
        summary: synthesis.slice(0, 4000),
        llm_calls: llmCalls,
        analyzed_files: sources.length,
      },
    });
    return { rawResult: safe, totalCostUsd };
  }

  return { rawResult: finalRaw, totalCostUsd };
}
