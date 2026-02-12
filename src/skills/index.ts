import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { getSkillLibraryPath, copySkillAssets } from "./library.js";
import type { AgentRole } from "../shared/types.js";

const log = createLogger("skills");

const skillCache = new Map<string, string | null>();

/**
 * Load a SKILL.md file content for a given role from the source skills directory.
 * Results are cached for the lifetime of the process.
 */
export function loadSkill(role: AgentRole): string | null {
  if (skillCache.has(role)) return skillCache.get(role) ?? null;

  try {
    const skillPath = resolve(config.skillsDir, role, "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    skillCache.set(role, content);
    log.debug("Loaded skill", { role, path: skillPath });
    return content;
  } catch {
    skillCache.set(role, null);
    log.debug("No skill file found", { role });
    return null;
  }
}

/**
 * Prepare the workspace's .claude/skills/ directory for a specific agent.
 *
 * 1. Clears any existing .md files in the skills directory
 * 2. Optionally writes the role's SKILL.md (persona) if role is provided
 * 3. For each library skill, copies its SKILL.md as `{skill-name}.md`
 *    and copies supporting directories (scripts/, templates/, etc.)
 */
export function injectSkills(
  workdir: string,
  role: AgentRole | null = null,
  skills: string[] = []
): void {
  const skillsDir = resolve(workdir, ".claude", "skills");

  // Ensure directory exists
  mkdirSync(skillsDir, { recursive: true });

  // Clear previous skills from this workspace
  try {
    const existing = readdirSync(skillsDir);
    for (const file of existing) {
      if (file.endsWith(".md")) {
        rmSync(resolve(skillsDir, file), { force: true });
      }
    }
  } catch {
    // Directory might not exist yet
  }

  // 1. Optionally inject the role's skill (persona) if role is provided
  if (role) {
    const roleContent = loadSkill(role);
    if (roleContent) {
      const targetPath = resolve(skillsDir, `${role}.md`);
      writeFileSync(targetPath, roleContent, "utf-8");
      log.debug("Injected role skill", { role, path: targetPath });
    }
  }

  // 2. Inject each library skill
  for (const skillName of skills) {
    const skillDir = getSkillLibraryPath(skillName);
    const skillMdPath = resolve(skillDir, "SKILL.md");

    if (!existsSync(skillMdPath)) {
      log.warn("Library skill not found, skipping", { skill: skillName });
      continue;
    }

    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const targetPath = resolve(skillsDir, `${skillName}.md`);
      writeFileSync(targetPath, content, "utf-8");
      log.debug("Injected library skill", { skill: skillName, path: targetPath });

      // Copy supporting directories
      copySkillAssets(skillName, skillsDir);
    } catch (err) {
      log.warn("Failed to inject library skill", {
        skill: skillName,
        error: String(err),
      });
    }
  }
}

/**
 * @deprecated Use injectSkills() instead
 */
export function injectSkillForRole(
  workdir: string,
  role: AgentRole
): string | null {
  injectSkills(workdir, role);
  const targetPath = resolve(workdir, ".claude", "skills", `${role}.md`);
  return existsSync(targetPath) ? targetPath : null;
}
