import { dirname, basename, join, relative, resolve } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import YAML from "yaml";
import type { ContextSlot } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import type { PathManagerAPI } from "#src/core/types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  license?: unknown;
  compatibility?: unknown;
  metadata?: unknown;
  "allowed-tools"?: unknown;
  [key: string]: unknown;
}

export interface SkillIndexItem {
  name: string;
  description: string;
  filePath: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

interface SkillDocument {
  name: string;
  description: string;
  filePath: string;
  content: string;
  references: string[];
  scripts: string[];
  assets: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

const warnedOverrides = new Set<string>();

function skillDirs(pm: PathManagerAPI, agentId: string, currentDir?: string): string[] {
  const candidates = [
    join(pm.team().root(), "skills"),
    join(pm.agent(agentId).root(), "skills"),
    ...(currentDir ? [
      join(currentDir, "skills"),
      join(currentDir, ".cursor", "skills-cursor"),
      join(currentDir, ".claude", "skills"),
    ] : []),
  ];

  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dirs.push(normalized);
  }

  return dirs;
}

export function discoverSkills(pm: PathManagerAPI, agentId: string, currentDir?: string): SkillIndexItem[] {
  const map = new Map<string, SkillIndexItem>();

  for (const dir of skillDirs(pm, agentId, currentDir)) {
    for (const filePath of discoverSkillFiles(dir)) {
      const skill = parseSkillIndex(filePath);
      if (!skill) continue;
      const previous = map.get(skill.name);
      if (previous && !warnedOverrides.has(`${previous.filePath}->${skill.filePath}`)) {
        warnedOverrides.add(`${previous.filePath}->${skill.filePath}`);
        console.info(
          `skill "${skill.name}" overridden: ${relative(pm.root(), previous.filePath)} -> ${relative(pm.root(), skill.filePath)}`,
        );
      }
      map.set(skill.name, skill);
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkillByName(pm: PathManagerAPI, agentId: string, name: string, currentDir?: string): SkillDocument | null {
  const skill = discoverSkills(pm, agentId, currentDir).find((entry) => entry.name === name);
  if (!skill) return null;
  return readSkillDocument(skill);
}

export function createSkillsSummarySlot(
  pm: PathManagerAPI,
  agentId: string,
  getCurrentDir?: () => string | undefined,
): ContextSlot {
  return {
    name: "skills",
    priority: SlotPriority.DYNAMIC_SKILLS,
    cacheHint: "dynamic",
    content: () => {
      const skills = discoverSkills(pm, agentId, getCurrentDir?.());
      if (skills.length === 0) return "";
      const lines = ["## Available Skills"];
      for (const skill of skills) {
        let line = `- ${skill.name}: ${skill.description}`;
        if (skill.compatibility) line += ` [requires: ${skill.compatibility}]`;
        lines.push(line);
      }
      lines.push(
        "",
        "IMPORTANT: When a task matches a skill, you MUST call read_skill first to get detailed instructions before proceeding.",
        "If the skill references supporting files under references/, scripts/, or assets/, use the standard read_file tool to inspect them on demand.",
      );
      return lines.join("\n");
    },
    version: 0,
  };
}

function parseSkillIndex(path: string): SkillIndexItem | null {
  try {
    const raw = getSandboxFs().readTextSync(path);
    const { frontmatter, body } = splitSkillFile(raw);
    const name = asNonEmptyString(frontmatter.name) ?? basename(dirname(path));
    const description = asNonEmptyString(frontmatter.description) ?? deriveDescription(body);
    const license = asNonEmptyString(frontmatter.license) ?? undefined;
    const compatibility = asNonEmptyString(frontmatter.compatibility) ?? undefined;
    const metadata = parseMetadata(frontmatter.metadata);
    const allowedTools = parseAllowedTools(frontmatter["allowed-tools"]);

    return {
      name,
      description,
      filePath: path,
      license,
      compatibility,
      metadata,
      allowedTools,
    };
  } catch {
    return null;
  }
}

function readSkillDocument(skill: SkillIndexItem): SkillDocument {
  const raw = getSandboxFs().readTextSync(skill.filePath);
  const { body } = splitSkillFile(raw);
  const rootDir = dirname(skill.filePath);

  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    content: body,
    references: listFiles(join(rootDir, "references")).map((entry) => join(rootDir, "references", entry)),
    scripts: listFiles(join(rootDir, "scripts")).map((entry) => join(rootDir, "scripts", entry)),
    assets: listFiles(join(rootDir, "assets")).map((entry) => join(rootDir, "assets", entry)),
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata,
    allowedTools: skill.allowedTools,
  };
}

function discoverSkillFiles(dir: string): string[] {
  const discovered: string[] = [];
  walkDir(dir, discovered);
  return discovered.sort((a, b) => a.localeCompare(b));
}

function walkDir(dir: string, discovered: string[]): void {
  try {
    const names = getSandboxFs().readdirSync(dir).sort();
    for (const name of names) {
      const fullPath = join(dir, name);
      const st = getSandboxFs().statSync(fullPath);
      if (!st) continue;
      if (st.isDirectory) {
        walkDir(fullPath, discovered);
        continue;
      }
      if (st.isFile && name === "SKILL.md") {
        discovered.push(fullPath);
      }
    }
  } catch {
    // Ignore missing or unreadable directories.
  }
}

function splitSkillFile(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  try {
    const parsed = YAML.parse(match[1]) ?? {};
    return {
      frontmatter: isRecord(parsed) ? parsed as SkillFrontmatter : {},
      body: raw.slice(match[0].length).trim(),
    };
  } catch {
    return { frontmatter: {}, body: raw.slice(match[0].length).trim() };
  }
}

function listFiles(dir: string): string[] {
  if (!getSandboxFs().existsSync(dir)) return [];
  const files: string[] = [];
  walkResourceDir(dir, dir, files);
  return files.sort((a, b) => a.localeCompare(b));
}

function walkResourceDir(root: string, dir: string, files: string[]): void {
  try {
    const names = getSandboxFs().readdirSync(dir).sort();
    for (const name of names) {
      const fullPath = join(dir, name);
      const st = getSandboxFs().statSync(fullPath);
      if (!st) continue;
      if (st.isDirectory) {
        walkResourceDir(root, fullPath, files);
        continue;
      }
      if (st.isFile) {
        files.push(relative(root, fullPath).replace(/\\/g, "/"));
      }
    }
  } catch {
    // Ignore missing or unreadable directories.
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function deriveDescription(body: string): string {
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((entry) => entry.replace(/\r?\n/g, " ").trim())
    .find(Boolean);
  return paragraph ?? "No description provided.";
}

function parseMetadata(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  let hasKeys = false;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") { result[k] = v; hasKeys = true; }
  }
  return hasKeys ? result : undefined;
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
