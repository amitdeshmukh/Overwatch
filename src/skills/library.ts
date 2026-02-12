import {
  readdirSync,
  readFileSync,
  existsSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("skill-library");

const SKILLS_REPO_TARBALL =
  "https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz";

export interface SkillManifestEntry {
  name: string;
  description: string;
}

let cachedManifest: SkillManifestEntry[] | null = null;

/**
 * Parse YAML frontmatter from a SKILL.md file to extract name and description.
 * Expects format:
 * ---
 * name: skill-name
 * description: What this skill does
 * ---
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
  };
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md files.
 * Returns a map of skill name → manifest entry.
 */
function scanSkillsDir(dirPath: string): Map<string, SkillManifestEntry> {
  const entries = new Map<string, SkillManifestEntry>();
  if (!existsSync(dirPath)) {
    log.debug("Skills directory not found", { path: dirPath });
    return entries;
  }

  try {
    const dirs = readdirSync(dirPath, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;

      const skillMdPath = join(dirPath, dir.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, "utf-8");
        const { name, description } = parseFrontmatter(content);
        const skillName = name ?? dir.name;
        entries.set(skillName, {
          name: skillName,
          description: description ?? "",
        });
      } catch {
        log.debug("Failed to read skill manifest", { path: skillMdPath });
      }
    }
  } catch {
    log.debug("Failed to scan skills directory", { path: dirPath });
  }

  return entries;
}

/**
 * Scan both bundled and external skill library directories and build a manifest.
 * Bundled skills are scanned first; external skills override bundled ones with the same name.
 * Results are cached per process.
 */
export function getSkillManifest(): SkillManifestEntry[] {
  if (cachedManifest) return cachedManifest;

  // Scan bundled skills first
  const merged = scanSkillsDir(config.bundledSkillsDir);

  // Scan external skills — these override bundled ones with the same name
  const externalSkills = scanSkillsDir(resolve(config.skillLibraryDir, "skills"));
  for (const [name, entry] of externalSkills) {
    merged.set(name, entry);
  }

  cachedManifest = Array.from(merged.values());
  log.info("Loaded skill library manifest", { count: cachedManifest.length });
  return cachedManifest;
}

/**
 * Get the full path to a skill directory in the library.
 * Checks external first (higher priority), then falls back to bundled.
 * This matches getSkillManifest() where external overrides bundled.
 */
export function getSkillLibraryPath(skillName: string): string {
  const externalPath = resolve(config.skillLibraryDir, "skills", skillName);
  if (existsSync(externalPath)) {
    return externalPath;
  }
  return resolve(config.bundledSkillsDir, skillName);
}

/**
 * Copy a skill's supporting directories (scripts/, templates/, reference/, core/)
 * from the library into the workspace's .claude/skills/ directory.
 */
export function copySkillAssets(skillName: string, targetDir: string): void {
  const skillDir = getSkillLibraryPath(skillName);
  const supportDirs = ["scripts", "templates", "reference", "core"];

  for (const subdir of supportDirs) {
    const srcPath = join(skillDir, subdir);
    if (!existsSync(srcPath)) continue;

    const destPath = join(targetDir, `${skillName}-${subdir}`);
    try {
      cpSync(srcPath, destPath, { recursive: true });
      log.debug("Copied skill assets", { skill: skillName, subdir, dest: destPath });
    } catch (err) {
      log.warn("Failed to copy skill assets", {
        skill: skillName,
        subdir,
        error: String(err),
      });
    }
  }
}

/**
 * Download and install the skill library from GitHub if not already present.
 * Downloads the anthropics/skills tarball and extracts the skills/ directory.
 * Called automatically on daemon startup — no git required.
 */
export async function ensureSkillLibrary(): Promise<void> {
  const skillsRoot = resolve(config.skillLibraryDir, "skills");
  if (existsSync(skillsRoot)) {
    log.debug("Skill library already installed", { path: skillsRoot });
    return;
  }

  log.info("Downloading skill library from GitHub...");
  mkdirSync(config.skillLibraryDir, { recursive: true });

  const tarballPath = join(config.skillLibraryDir, ".download.tar.gz");

  try {
    const res = await fetch(SKILLS_REPO_TARBALL, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    // Download to a temp file
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(tarballPath, buffer);

    // Extract — GitHub archives have a `skills-main/` prefix, strip it
    execSync(`tar xzf "${tarballPath}" --strip-components=1`, {
      cwd: config.skillLibraryDir,
      stdio: "ignore",
    });

    // Clean up tarball
    rmSync(tarballPath, { force: true });

    log.info("Skill library installed", { path: config.skillLibraryDir });
  } catch (err) {
    log.warn("Failed to download skill library — skills will be unavailable", {
      error: String(err),
    });
    // Clean up partial download
    try {
      rmSync(tarballPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
