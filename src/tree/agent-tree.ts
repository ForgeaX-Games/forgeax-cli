/** @desc AgentTree — agent topology data structure + JSON persistence + lifecycle */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hook, createHookEvent } from "../hooks/types.js";
import type {
  AgentNodeData,
  AgentRole,
  AgentTreeManagerAPI,
  AgentTreeCallbacks,
  AgentTreeNode,
  CreateAgentParams,
  FSWatcherAPI,
  PathManagerAPI,
  SyncFromDiskResult,
} from "../core/types.js";
import { createAgentTemplateFolder } from "../team/agent-scaffold.js";

interface StoredNode {
  id: string;
  role: AgentRole;
  parentId: string | null;
  childIds: string[];
  groups: string[];
  spawnedAt: number;
}

// 解析兼容：内存模型无 v1/v2 概念，仅从磁盘加载时做格式兼容。
// 旧格式 (v1): nodes 为 map —— { "id": { ... } }
// 新格式 (v2): nodes 为 list —— [ { "id": "...", ... } ]
function parseAgentTreeJson(raw: string): StoredNode[] {
  const data = JSON.parse(raw);
  const rawNodes: unknown = data.nodes;
  if (!rawNodes) return [];

  // ── 向后兼容：v1 map 格式 { "id": { ... } } ──
  if (typeof rawNodes === "object" && !Array.isArray(rawNodes) && rawNodes !== null) {
    const map = rawNodes as Record<string, Record<string, unknown>>;
    return Object.entries(map).map(([key, node]) => normalizeStoredNode({
      ...node,
      // v1 格式中外层 key 即 agent id，优先用 key
      id: (typeof node.id === "string" ? node.id : undefined) ?? key,
    }));
  }
  // ── 向后兼容结束 ──

  // v2 list 格式
  if (Array.isArray(rawNodes)) {
    return (rawNodes as Record<string, unknown>[]).map(n => normalizeStoredNode(n));
  }

  return [];
}

/** normalize: 保证 groups/childIds 有默认值 */
function normalizeStoredNode(raw: Record<string, unknown>): StoredNode {
  return {
    id: String(raw.id ?? ""),
    role: (raw.role as AgentRole) ?? "worker",
    parentId: raw.parentId != null ? String(raw.parentId) : null,
    childIds: Array.isArray(raw.childIds) ? raw.childIds.map(String) : [],
    groups: Array.isArray(raw.groups) ? raw.groups.map(String) : [],
    spawnedAt: typeof raw.spawnedAt === "number" ? raw.spawnedAt : Date.now(),
  };
}


export type TreeEventType = "create" | "free" | "attach" | "detach";

export interface TreeEvent {
  type: TreeEventType;
  agentId: string;
  parentId?: string | null;
  ts: number;
}


const WATCHER_OWNER = "agent-tree";
/** Matches the top-level agent directory entry inside team/agents/ (e.g. "coderx").
 *  Path is relative to the watched team/agents/ directory, so no leading prefix. */
const AGENT_DIR_TOPLEVEL = /^([^/]+)\/?$/;

interface EventBusLike {
  publish(event: import("../core/types.js").Event, emitterId?: string): void;
}

const TREE_EVENT_TO_HOOK: Record<TreeEventType, string> = {
  attach:   Hook.AgentAttach,
  detach:   Hook.AgentDetach,
  create:   Hook.AgentCreate,
  free:     Hook.AgentFree,
};

export class AgentTree implements AgentTreeManagerAPI {
  private nodes = new Map<string, StoredNode>();
  private readonly filePath: string;
  private readonly pathManager: PathManagerAPI;
  private lastWriteTs = 0;
  private fsWatcher: FSWatcherAPI | null = null;
  private callbacks: AgentTreeCallbacks = {};
  private eventBus: EventBusLike | null = null;

  constructor(pathManager: PathManagerAPI, eventBus?: EventBusLike) {
    this.pathManager = pathManager;
    this.filePath = pathManager.team().agentTree();
    this.eventBus = eventBus ?? null;
  }

  private emit(event: TreeEvent, emitterId?: string): void {
    const hookType = TREE_EVENT_TO_HOOK[event.type];
    if (hookType && this.eventBus) {
      this.eventBus.publish(createHookEvent(hookType, { ...event }, "system:agentTree"), emitterId);
    }
  }

  // ─── Role ───────────────────────────────────────────────────────────────────

  /** Infer a default role when none is explicitly provided at creation time. */
  private inferDefaultRole(parentId: string | null): AgentRole {
    if (parentId !== null) return "worker";
    const hasRoot = [...this.nodes.values()].some(n => n.parentId === null);
    return hasRoot ? "steward" : "admin";
  }

  private toExternal(node: StoredNode): AgentNodeData {
    return { ...node };
  }

  // ─── Query ──────────────────────────────────────────────────────────────────

  getNode(id: string): AgentNodeData | null {
    const node = this.nodes.get(id);
    return node ? this.toExternal(node) : null;
  }

  getParent(id: string): AgentNodeData | null {
    const node = this.nodes.get(id);
    if (!node?.parentId) return null;
    const parent = this.nodes.get(node.parentId);
    return parent ? this.toExternal(parent) : null;
  }

  getChildren(id: string): AgentNodeData[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.childIds.map(cid => this.nodes.get(cid)).filter(Boolean).map(n => this.toExternal(n!));
  }

  getAncestors(id: string): AgentNodeData[] {
    const result: AgentNodeData[] = [];
    let current = this.nodes.get(id);
    while (current?.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;
      result.push(this.toExternal(parent));
      current = parent;
    }
    return result;
  }

  getDescendants(id: string): AgentNodeData[] {
    const result: AgentNodeData[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const cid = stack.pop()!;
      const node = this.nodes.get(cid);
      if (!node) continue;
      if (cid !== id) result.push(this.toExternal(node));
      stack.push(...node.childIds);
    }
    return result;
  }

  allNodes(): AgentNodeData[] {
    return [...this.nodes.values()].map(n => this.toExternal(n));
  }

  roots(): AgentNodeData[] {
    return [...this.nodes.values()].filter(n => n.parentId === null).map(n => this.toExternal(n));
  }

  /**
   * Compute tree-derived writable paths for an agent (real-time, no storage).
   * Returns relative paths under team/ that the agent is allowed to write to
   * based solely on tree topology (self dirs, direct children dirs, shared-workspace).
   *
   * Scope: team/ directory ONLY. Paths outside team/ (instance root: src/, capabilities/,
   * docs/) are not covered here — those default to read-only and are unlocked by evolve_mode
   * (TeamBoard STATUS). Permission enforcement is at the application layer
   * (capabilities/workspace/lib/file-write-permissions.ts).
   *
   * Note: sessions/{id}/ and logs/{id}/ are NOT included — those are written by
   * framework internals (EventStore, logger), not by agent file tools.
   */
  getWritablePaths(agentId: string): string[] {
    const node = this.nodes.get(agentId);
    if (!node) return [];

    const paths: string[] = [];

    // Self directories
    paths.push(`homes/${agentId}/`, `agents/${agentId}/`);

    // Direct children directories (parent → child write access)
    for (const childId of node.childIds) {
      paths.push(`homes/${childId}/`, `agents/${childId}/`);
    }

    // Shared workspace (all agents)
    paths.push("shared-workspace/");

    return paths;
  }

  view(rootId: string, depth?: number): AgentTreeNode | null {
    const node = this.nodes.get(rootId);
    if (!node) return null;
    return this.buildTreeNode(node, depth);
  }

  private buildTreeNode(node: StoredNode, depth: number | undefined): AgentTreeNode {
    if (depth !== undefined && depth <= 0) {
      return { node: this.toExternal(node), children: [] };
    }
    const nextDepth = depth !== undefined ? depth - 1 : undefined;
    const children = node.childIds
      .map(cid => this.nodes.get(cid))
      .filter(Boolean)
      .map(child => this.buildTreeNode(child!, nextDepth));
    return { node: this.toExternal(node), children };
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  roleOf(id: string): AgentRole | null {
    const node = this.nodes.get(id);
    return node ? node.role : null;
  }

  getByRole(role: AgentRole): AgentNodeData[] {
    return [...this.nodes.values()]
      .filter(n => n.role === role)
      .map(n => this.toExternal(n));
  }

  getGroupMembers(group: string): AgentNodeData[] {
    return [...this.nodes.values()]
      .filter(n => n.groups.includes(group))
      .map(n => this.toExternal(n));
  }

  getAgentGroups(id: string): string[] {
    const node = this.nodes.get(id);
    return node ? [...node.groups] : [];
  }

  updateGroups(id: string, groups: string[]): void {
    const node = this.nodes.get(id);
    if (!node) return;
    // 去重 + 排序
    node.groups = [...new Set(groups.filter(g => g.trim()))].sort();
    this.writeToDisk();
  }

  // ─── Low-level Mutation ─────────────────────────────────────────────────────

  attach(node: Omit<AgentNodeData, "childIds" | "role" | "groups">, parentId: string | null, emitterId?: string): void {
    const existing = this.nodes.get(node.id);
    if (existing) {
      if (existing.parentId !== parentId) {
        this.reparent(node.id, parentId);
      }
      return;
    }

    const stored: StoredNode = {
      id: node.id,
      role: this.inferDefaultRole(parentId),
      parentId,
      childIds: [],
      groups: [],
      spawnedAt: node.spawnedAt,
    };

    if (parentId !== null) {
      const parent = this.nodes.get(parentId);
      if (!parent) throw new Error(`attach: parent '${parentId}' not found`);
      parent.childIds.push(node.id);
    }

    this.nodes.set(node.id, stored);
    this.writeToDisk();
    this.emit({ type: "attach", agentId: node.id, parentId, ts: Date.now() }, emitterId);
  }

  /**
   * Detach a node from its current parent — the node becomes a root.
   * Does NOT remove the node from the tree or affect its children.
   */
  detach(id: string, emitterId?: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.parentId === null) return; // already root

    const oldParentId = node.parentId;
    const parent = this.nodes.get(oldParentId);
    if (parent) {
      parent.childIds = parent.childIds.filter(cid => cid !== id);
    }

    node.parentId = null;
    this.writeToDisk();
    // parentId carries the parent being detached FROM (for topology tracking)
    this.emit({ type: "detach", agentId: id, parentId: oldParentId, ts: Date.now() }, emitterId);
  }

  updateRole(id: string, role: AgentRole): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.role = role;
    this.writeToDisk();
  }

  reparent(id: string, newParentId: string | null): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`reparent: node '${id}' not found`);
    if (newParentId !== null && !this.nodes.has(newParentId)) {
      throw new Error(`reparent: new parent '${newParentId}' not found`);
    }
    if (id === newParentId) throw new Error("reparent: cannot set self as parent");
    if (node.parentId === newParentId) return;

    if (newParentId !== null) {
      let cur = this.nodes.get(newParentId);
      while (cur?.parentId) {
        if (cur.parentId === id) throw new Error(`reparent: '${newParentId}' is a descendant of '${id}', would create cycle`);
        cur = this.nodes.get(cur.parentId);
      }
    }

    // detach from old parent (emits "detach")
    this.detach(id);

    // attach to new parent
    if (newParentId !== null) {
      const newParent = this.nodes.get(newParentId)!;
      newParent.childIds.push(id);
    }
    node.parentId = newParentId;
    this.writeToDisk();
    this.emit({ type: "attach", agentId: id, parentId: newParentId, ts: Date.now() });
  }

  // ─── High-level Lifecycle ───────────────────────────────────────────────────

  async create(params: CreateAgentParams): Promise<{ ok: true } | { ok: false; error: string }> {
    const { id, parentId = null, role, template, emitterId, fillFromParent, mergeParentAgentJson, agentType } = params;

    // Compute the role that will apply after attach() so scaffold picks the right
    // default SOUL personality template. Explicit param wins; otherwise fall back to
    // the same inference attach() uses.
    const effectiveRole = role ?? this.inferDefaultRole(parentId);

    const result = await createAgentTemplateFolder(id, {
      template,
      parentId: parentId ?? undefined,
      fillFromParent,
      mergeParentAgentJson,
      role: effectiveRole,
      agentType,
    });
    if (!result.ok) return result;

    this.attach({
      id,
      parentId,
      spawnedAt: Date.now(),
    }, parentId, emitterId);

    if (role) this.updateRole(id, role);

    this.emit({ type: "create", agentId: id, parentId, ts: Date.now() }, emitterId);
    return { ok: true };
  }

  async free(id: string, emitterId?: string): Promise<void> {
    const node = this.nodes.get(id);

    const agentDir = this.pathManager.agent(id).root();
    const homeDir = this.pathManager.team().homeFor(id);
    for (const dir of [agentDir, homeDir]) {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // Detach from parent (emits "detach" if had a parent)
    this.detach(id, emitterId);

    // Promote children to root level
    if (node) {
      for (const childId of node.childIds) {
        const child = this.nodes.get(childId);
        if (child) child.parentId = null;
      }
    }

    // Remove from tree entirely
    this.nodes.delete(id);
    this.writeToDisk();
    this.emit({ type: "free", agentId: id, ts: Date.now() }, emitterId);
  }

  async syncFromDisk(): Promise<SyncFromDiskResult> {
    const agentsDir = this.pathManager.team().agentsDir();
    let diskIds: string[];
    try {
      const entries = await readdir(agentsDir);
      diskIds = [];
      for (const entry of entries) {
        const s = await stat(join(agentsDir, entry));
        if (s.isDirectory()) diskIds.push(entry);
      }
    } catch {
      return { added: [], removed: [], all: [] };
    }

    const diskIdSet = new Set(diskIds);
    const added: string[] = [];
    const removed: string[] = [];

    for (const id of diskIds) {
      if (!this.nodes.has(id)) {
        const result = await this.create({ id });
        if (result.ok) added.push(id);
      }
    }

    for (const id of [...this.nodes.keys()]) {
      if (!diskIdSet.has(id)) {
        await this.free(id);
        removed.push(id);
      }
    }

    return { added, removed, all: diskIds };
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    this._loadFromFile();
  }

  private reloadFromDisk(): void {
    this._loadFromFile();
  }

  private _loadFromFile(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const nodes = parseAgentTreeJson(raw);
      this.nodes.clear();
      for (const node of nodes) this.nodes.set(node.id, node);
    } catch { /* corrupted or missing — start fresh */ }
  }

  startWatching(watcher: FSWatcherAPI, callbacks?: AgentTreeCallbacks): void {
    this.stopWatching();
    this.fsWatcher = watcher;
    this.callbacks = callbacks ?? {};

    watcher.watchFile(this.pathManager.team().agentTree(), () => {
      if (Date.now() - this.lastWriteTs < 500) return;
      this.reloadFromDisk();
    }, { ownerId: WATCHER_OWNER });

    watcher.watchDir(this.pathManager.team().agentsDir(), async (evt) => {
      const match = evt.path.match(AGENT_DIR_TOPLEVEL);
      if (!match) return;
      const agentId = match[1];

      const agentRoot = this.pathManager.agent(agentId).root();
      if (existsSync(agentRoot) && statSync(agentRoot).isDirectory()) {
        if (!this.nodes.has(agentId)) {
          const result = await this.create({ id: agentId });
          if (!result.ok) return;
        }
        await this.callbacks.onAgentCreated?.(agentId);
      } else if (this.nodes.has(agentId)) {
        await this.free(agentId);
        await this.callbacks.onAgentFreed?.(agentId);
      }
    }, { ownerId: WATCHER_OWNER, pattern: AGENT_DIR_TOPLEVEL });
  }

  stopWatching(): void {
    this.fsWatcher?.unregisterOwner(WATCHER_OWNER);
    this.fsWatcher = null;
    this.callbacks = {};
  }

  private writeToDisk(): void {
    const nodeList = [...this.nodes.values()];
    // 语义比较（不含 updatedAt）：旧文件 nodes 与内存一致则不写，避免 FSWatcher 自触发循环
    const semantic = JSON.stringify({ version: 2, nodes: nodeList });
    try {
      if (existsSync(this.filePath)) {
        const existingNodes = JSON.parse(readFileSync(this.filePath, "utf-8")).nodes ?? [];
        if (JSON.stringify({ version: 2, nodes: existingNodes }) === semantic) return;
      }
    } catch { /* read/parse failed — proceed to write */ }
    const newContent = JSON.stringify({ version: 2, updatedAt: Date.now(), nodes: nodeList }, null, 2) + "\n";
    try {
      writeFileSync(this.filePath, newContent, "utf-8");
      this.lastWriteTs = Date.now();
    } catch { /* write failed — non-critical */ }
  }
}
