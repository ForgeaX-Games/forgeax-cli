/** @desc Pack scaffold — create / complete pack directories with default admin agent */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PACK_JSON, type PackJson } from "../../defaults/pack/pack-json.js";
import { defaultSoulForRole } from "../../defaults/agent/role-souls.js";
import { defaultPrincipleTemplate } from "../../defaults/agent/principle.js";
import { AGENT_DEFAULTS, SCRIPT_AGENT_TEMPLATE } from "../../defaults/agent/agent-json.js";
import { getSharedPaths } from "../../fs/state-dir.js";
import { defaultSetupShTemplate } from "../../defaults/pack/setup-sh.js";
import { STANDARD_DEFINITION_DIRS } from "../../team/agent-scaffold.js";
import { SCRIPT_ENTRY_SEGMENTS } from "../../core/script-agent.js";
import type { AgentRole } from "../../core/types.js";


const PACK_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function isValidPackId(id: string): boolean {
  return PACK_ID_RE.test(id);
}

export interface CreatePackOptions {
  description?: string;
  /** Optional scaffold template id (reserved for future / alternate scaffolds). */
  template?: string;
}

/** Read default model from agenteam.json so scaffolded agent.json gets a concrete value instead of null. */
function readGlobalDefaultModel(): string | null {
  try {
    const raw = readFileSync(getSharedPaths().agenteamConfig(), "utf-8");
    const cfg = JSON.parse(raw) as { models?: { model?: string } };
    return cfg?.models?.model ?? null;
  } catch { return null; }
}

// ─── Shared scaffold helpers ──────────────────────────────────────────────────

/**
 * Build agent-tree.json by scanning the agents/ directory.
 * Reconcilies with existing tree: keeps existing nodes' role/parentId/childIds/groups.
 * New directories → default root node (first matched with defaultAgentId → admin, rest → steward).
 * Deleted directories → removed from tree.
 * Content is written only if it differs from the existing file.
 */
async function buildAgentTreeFromDir(agentsDir: string, defaultAgentId: string): Promise<string> {
  // Scan agents/ for directories
  let dirNames: string[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    dirNames = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { dirNames = []; }

  // Load existing tree to preserve role/parentId/childIds/groups
  const treePath = join(agentsDir, "agent-tree.json");
  const existing = new Map<string, Record<string, unknown>>();
  let existingRaw = "";
  if (existsSync(treePath)) {
    try {
      existingRaw = readFileSync(treePath, "utf-8");
      const data = JSON.parse(existingRaw);
      const rawNodes: unknown = data.nodes;
      // 兼容 v1 map / v2 list 格式
      if (Array.isArray(rawNodes)) {
        for (const n of rawNodes as Record<string, unknown>[]) {
          if (typeof n.id === "string") existing.set(n.id, n);
        }
      } else if (typeof rawNodes === "object" && rawNodes !== null) {
        for (const [key, node] of Object.entries(rawNodes as Record<string, Record<string, unknown>>)) {
          existing.set(key, { id: key, ...node });
        }
      }
    } catch { /* start fresh */ }
  }

  // Merge: keep existing, add new, remove deleted; normalize dangling refs
  const dirNameSet = new Set(dirNames);
  const now = Date.now();
  const nodes: Record<string, unknown>[] = [];
  for (const name of dirNames) {
    if (existing.has(name)) {
      const node = existing.get(name)!;
      // 拓扑归一化：清掉指向已删除目录的 parentId / childIds（review !260 P2）
      const childIds = Array.isArray(node.childIds)
        ? [...new Set((node.childIds as unknown[]).filter(id => typeof id === "string" && dirNameSet.has(id)))]
        : [];
      const parentId = typeof node.parentId === "string" && dirNameSet.has(node.parentId)
        ? node.parentId
        : null;
      nodes.push({ ...node, parentId, childIds });
    } else {
      nodes.push({ id: name, role: name === defaultAgentId ? "admin" : "steward", parentId: null, childIds: [], groups: [], spawnedAt: now });
    }
  }

  // 语义比较（不含 updatedAt）：旧文件 nodes 与新 nodes 一致则不写
  const semantic = JSON.stringify({ version: 2, nodes });
  let existingSemantic = "";
  try {
    if (existingRaw) {
      const data = JSON.parse(existingRaw);
      existingSemantic = JSON.stringify({ version: 2, nodes: data.nodes ?? [] });
    }
  } catch { /* proceed to write */ }
  if (existingSemantic === semantic) return existingRaw;

  const treeJson = JSON.stringify({ version: 2, updatedAt: now, nodes }, null, 2) + "\n";
  await writeFile(treePath, treeJson, "utf-8");
  return treeJson;
}

/**
 * Scaffold default files for a single agent directory.
 * `isDefaultAgent` = true → admin-level config & SOUL; false → regular agent defaults.
 * Never overwrites existing files.
 */
export interface ScaffoldAgentFilesOptions {
  /** Skip SOUL.md and PRINCIPLE.md creation (e.g. for ScriptAgents that don't use LLM). */
  skipPersonality?: boolean;
  /** Role to pick the default SOUL personality template. If omitted, falls back to
   *  `isDefaultAgent ? "admin" : "worker"` for backward-compat with pack-scaffold paths. */
  role?: AgentRole;
  /** Scaffold hint: "script" uses SCRIPT_AGENT_TEMPLATE (capabilities: none). Omit = conscious defaults. */
  agentType?: "conscious" | "script";
}

export async function scaffoldAgentFiles(
  agentDir: string,
  isDefaultAgent: boolean,
  opts?: ScaffoldAgentFilesOptions,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });

  if (!existsSync(join(agentDir, "agent.json"))) {
    const template = opts?.agentType === "script"
      ? SCRIPT_AGENT_TEMPLATE
      : AGENT_DEFAULTS;
    const globalModel = readGlobalDefaultModel();
    const agentJson = globalModel
      ? { ...template, models: { ...template.models, model: globalModel } }
      : template;
    await writeFile(join(agentDir, "agent.json"), JSON.stringify(agentJson, null, 2) + "\n", "utf-8");
  }
  const skipPersonality = opts?.skipPersonality ?? existsSync(join(agentDir, ...SCRIPT_ENTRY_SEGMENTS));
  if (!skipPersonality) {
    if (!existsSync(join(agentDir, "SOUL.md"))) {
      const role = opts?.role ?? (isDefaultAgent ? "admin" : "worker");
      await writeFile(join(agentDir, "SOUL.md"), defaultSoulForRole(role), "utf-8");
    }
    if (!existsSync(join(agentDir, "PRINCIPLE.md"))) {
      await writeFile(join(agentDir, "PRINCIPLE.md"), defaultPrincipleTemplate(), "utf-8");
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scaffold a new pack directory with:
 *   pack.json, agents/admin/{agent.json, SOUL.md, PRINCIPLE.md},
 *   startup-scripts/setup.sh, capabilities/
 *
 * Does NOT create runtime files (homes/, sessions/, memories/, .env, etc.)
 * — those are created by agent-scaffold when the pack is loaded into a team.
 */
export async function createPackScaffold(
  packDir: string,
  packId: string,
  opts?: CreatePackOptions,
): Promise<void> {
  if (!isValidPackId(packId)) {
    throw new Error(`Invalid pack id '${packId}'. Use only alphanumeric, dash, underscore.`);
  }
  if (existsSync(packDir)) {
    throw new Error(`Pack directory already exists: ${packDir}`);
  }

  await mkdir(packDir, { recursive: true });

  const packJson = {
    ...DEFAULT_PACK_JSON,
    id: packId,
    description: opts?.description ?? DEFAULT_PACK_JSON.description,
  };
  await writeFile(join(packDir, "pack.json"), JSON.stringify(packJson, null, 2) + "\n", "utf-8");

  await scaffoldAgentFiles(join(packDir, "agents", "admin"), true);

  // 从 agents/ 目录动态生成 tree（新 pack 只有 admin 目录，会自动产生单节点树）
  await buildAgentTreeFromDir(join(packDir, "agents"), "admin");

  const scriptsDir = join(packDir, "startup-scripts");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(join(scriptsDir, "setup.sh"), defaultSetupShTemplate(), "utf-8");

  for (const dir of STANDARD_DEFINITION_DIRS) await mkdir(join(packDir, dir), { recursive: true });
}

/**
 * Idempotent completeness check: fill in missing files without overwriting existing ones.
 * Suitable for directories that appear via manual copy or directory watcher.
 *
 * - Empty directory → full pack scaffold (pack.json + admin agent + startup-scripts + capabilities)
 * - Missing agent files → scaffold with appropriate template (admin vs regular)
 * - Never overwrites existing files.
 */
export async function ensurePackCompleteness(packDir: string, packId: string): Promise<void> {
  if (!existsSync(join(packDir, "pack.json"))) {
    const packJson = { ...DEFAULT_PACK_JSON, id: packId };
    await writeFile(join(packDir, "pack.json"), JSON.stringify(packJson, null, 2) + "\n", "utf-8");
  }

  const defaultAgent = await readDefaultAgent(packDir);

  const agentsDir = join(packDir, "agents");
  if (!existsSync(agentsDir)) {
    await mkdir(agentsDir, { recursive: true });
  }

  const agentEntries = await readdir(agentsDir, { withFileTypes: true });
  const agentDirs = agentEntries.filter((e) => e.isDirectory());

  if (agentDirs.length === 0) {
    await scaffoldAgentFiles(join(agentsDir, defaultAgent), true);
  } else {
    for (const entry of agentDirs) {
      const isDefault = entry.name === defaultAgent;
      await scaffoldAgentFiles(join(agentsDir, entry.name), isDefault);
    }
  }

  // 从 agents/ 目录动态生成/更新 tree（merge 模式：保留已有节点的 role/parentId/childIds/groups）
  await buildAgentTreeFromDir(agentsDir, defaultAgent);

  if (!existsSync(join(packDir, "startup-scripts"))) {
    const scriptsDir = join(packDir, "startup-scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, "setup.sh"), defaultSetupShTemplate(), "utf-8");
  }

  for (const dir of STANDARD_DEFINITION_DIRS) await mkdir(join(packDir, dir), { recursive: true });
}

/** Read default_agent from pack.json, fallback to "admin". */
async function readDefaultAgent(packDir: string): Promise<string> {
  try {
    const pj: PackJson = JSON.parse(await readFile(join(packDir, "pack.json"), "utf-8"));
    return pj.default_agent || "admin";
  } catch {
    return "admin";
  }
}
