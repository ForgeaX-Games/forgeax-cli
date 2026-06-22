// @desc Agent directory scaffolder — template copy + optional parent inheritance + framework defaults

import { existsSync, statSync, readFileSync } from "node:fs";
import { mkdir, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { defaultMemoryTemplate } from "../defaults/agent/memory.js";
import { getPathManager } from "../fs/path-manager.js";
import { scaffoldAgentFiles } from "../gateway/packs/pack-scaffold.js";
import { deepMerge } from "../core/deep-merge.js";
import { SCRIPT_ENTRY_SEGMENTS } from "../core/script-agent.js";
import { defaultScriptTemplate } from "../defaults/agent/script-template.js";

const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Framework-native subdirectories every agent/pack definition should contain. */
export const STANDARD_DEFINITION_DIRS = ["capabilities", "templates"];

export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_RE.test(agentId);
}

// ─── Template resolution ────────────────────────────────────────────────────

/**
 * Resolve a template name (e.g. "observe") across three layers:
 *   agent-local → team → instance
 * Returns the absolute path to the template directory, or null if not found.
 */
export function resolveTemplatePath(
  templateName: string,
  parentId?: string,
): string | null {
  if (!AGENT_ID_RE.test(templateName.replace(/\//g, ""))) return null;

  const pm = getPathManager();
  const candidates: string[] = [];

  if (parentId) {
    candidates.push(join(pm.agent(parentId).templatesDir(), templateName));
  }
  candidates.push(join(pm.team().templatesDir(), templateName));
  candidates.push(join(pm.instance().templatesDir(), templateName));

  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  return null;
}

// ─── Template metadata (opt-in flags from template.json) ────────────────────

/** Opt-in behaviors a template can declare in its `template.json`. */
export interface TemplateMeta {
  /** If true, non-destructively copy parent's agent dir into the new agent. */
  fillFromParent?: boolean;
  /** If true, deep-merge parent's agent.json into the new agent's (current wins). */
  mergeParentAgentJson?: boolean;
  /** If true, the new agent inherits parent's role (caller — e.g. subagent — applies). */
  inheritRole?: boolean;
}

/**
 * Peek at a template's `template.json` without creating any agent files.
 * Callers use this to read opt-in flags and feed them into scaffold / tree.create.
 */
export function resolveTemplateMeta(
  templateName?: string,
  parentId?: string,
): TemplateMeta {
  if (!templateName) return {};
  const dir = resolveTemplatePath(templateName, parentId);
  if (!dir) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "template.json"), "utf-8"));
    return {
      fillFromParent: typeof parsed.fillFromParent === "boolean" ? parsed.fillFromParent : undefined,
      mergeParentAgentJson: typeof parsed.mergeParentAgentJson === "boolean" ? parsed.mergeParentAgentJson : undefined,
      inheritRole: typeof parsed.inheritRole === "boolean" ? parsed.inheritRole : undefined,
    };
  } catch {
    return {};
  }
}

// ─── Scaffold ───────────────────────────────────────────────────────────────

export interface ScaffoldOptions {
  /** Template name to initialize from. Resolved across 3 layers. */
  template?: string;
  /** Parent agent ID — used for template resolution and inheritance flags below. */
  parentId?: string;
  /** Non-destructively copy parent's agent dir contents into the new agent. */
  fillFromParent?: boolean;
  /** Deep-merge parent's agent.json into the new agent's (current wins on conflicts). */
  mergeParentAgentJson?: boolean;
  /** Role for picking the default SOUL personality template. */
  role?: import("../core/types.js").AgentRole;
  /** Scaffold hint: "conscious" (default) or "script" (scaffolds src/index.ts). Omit = "conscious". */
  agentType?: "conscious" | "script";
}

export async function ensureAgentScaffoldDirs(agentId: string): Promise<void> {
  const pm = getPathManager();
  const agent = pm.agent(agentId);
  await mkdir(agent.root(), { recursive: true });
  await mkdir(pm.team().homeFor(agentId), { recursive: true });
  await mkdir(pm.team().ledgersFor(agentId), { recursive: true });

  for (const dir of STANDARD_DEFINITION_DIRS) await mkdir(join(agent.root(), dir), { recursive: true });

  if (!existsSync(agent.envFile())) {
    await writeFile(agent.envFile(), "", "utf-8");
  }

  const homeDir = pm.team().homeFor(agentId);
  await mkdir(join(homeDir, "memories", "knowledge"), { recursive: true });
  await mkdir(join(homeDir, "memories", "daily"), { recursive: true });
  await mkdir(join(homeDir, "memories", "experience"), { recursive: true });

  const memoryMdPath = join(homeDir, "MEMORY.md");
  if (!existsSync(memoryMdPath)) {
    await writeFile(memoryMdPath, defaultMemoryTemplate(agentId), "utf-8");
  }

  const overridesPath = join(homeDir, "agent-overrides.json");
  if (!existsSync(overridesPath)) {
    await writeFile(overridesPath, "{}\n", "utf-8");
  }
}

/**
 * Populate an agent's definition directory. Each step is non-destructive —
 * existing files/dirs at the target path are preserved.
 *
 *   1. Template → target            (recursive, skip existing)
 *   2. Parent → target              (recursive, skip existing; opt-in via fillFromParent)
 *   3. agent.json merge with parent (opt-in via mergeParentAgentJson; current wins)
 *   4. Framework defaults fill any remaining missing files
 */
export async function ensureAgentTemplateFiles(
  agentId: string,
  opts?: ScaffoldOptions,
): Promise<void> {
  const pm = getPathManager();
  const agent = pm.agent(agentId);
  const agentRoot = agent.root();

  await ensureAgentScaffoldDirs(agentId);

  // template.json is template-author metadata, not an agent runtime artifact —
  // exclude from any directory copy that targets the agent's definition dir.
  const excludeTemplateMeta = (src: string) => !src.endsWith("/template.json") && !src.endsWith("\\template.json");

  // 1. Apply template (recursive, non-destructive)
  if (opts?.template) {
    const templateDir = resolveTemplatePath(opts.template, opts.parentId);
    if (templateDir) {
      await cp(templateDir, agentRoot, { recursive: true, force: false, errorOnExist: false, filter: excludeTemplateMeta });
    }
  }

  // 2. Optionally copy parent's agent dir (recursive, non-destructive)
  const parentAgent = opts?.parentId ? pm.agent(opts.parentId) : null;
  if (opts?.fillFromParent && parentAgent && existsSync(parentAgent.root())) {
    await cp(parentAgent.root(), agentRoot, { recursive: true, force: false, errorOnExist: false, filter: excludeTemplateMeta });
  }

  // 3. Optionally deep-merge parent's agent.json into current (current wins on conflicts)
  if (opts?.mergeParentAgentJson && parentAgent) {
    const parentConfig = parentAgent.config();
    if (existsSync(agent.config()) && existsSync(parentConfig)) {
      try {
        const parentJson = JSON.parse(readFileSync(parentConfig, "utf-8"));
        const currentJson = JSON.parse(readFileSync(agent.config(), "utf-8"));
        const merged = deepMerge(parentJson, currentJson);
        await writeFile(agent.config(), JSON.stringify(merged, null, 2) + "\n", "utf-8");
      } catch { /* malformed JSON — leave current unchanged */ }
    }
  }

  // 4. If explicitly creating a ScriptAgent, scaffold the entry file so step 5 auto-skips SOUL/PRINCIPLE
  if (opts?.agentType === "script") {
    const srcDir = join(agentRoot, SCRIPT_ENTRY_SEGMENTS[0]);
    const entryFile = join(agentRoot, ...SCRIPT_ENTRY_SEGMENTS);
    if (!existsSync(entryFile)) {
      await mkdir(srcDir, { recursive: true });
      await writeFile(entryFile, defaultScriptTemplate(), "utf-8");
    }
  }

  // 5. Fill any remaining missing files with framework defaults
  //    (scaffoldAgentFiles auto-detects ScriptAgent via src/index.ts and skips SOUL/PRINCIPLE)
  await scaffoldAgentFiles(agentRoot, false, { role: opts?.role, agentType: opts?.agentType });
}

export async function createAgentTemplateFolder(
  agentId: string,
  opts?: ScaffoldOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidAgentId(agentId)) {
    return {
      ok: false,
      error: `Invalid agent id '${agentId}'. Use only alphanumeric, dash, underscore.`,
    };
  }

  await mkdir(getPathManager().agent(agentId).root(), { recursive: true });
  await ensureAgentTemplateFiles(agentId, opts);
  return { ok: true };
}
