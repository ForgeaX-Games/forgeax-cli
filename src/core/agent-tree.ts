/** AgentTree —— per-Session 的 agent 拓扑索引。
 *
 *  设计原则（用户钉死，2026-05-20）：
 *  1. **目录就是事实**：`<sid>/agents/<name>/` 存在 ⇔ 节点 `<name>` 存在。
 *     套娃：`<sid>/agents/<name>/agents/<sub>/`。`agent.json` 是可选配置，
 *     缺失时 SessionManager 用 `AGENT_DEFAULTS` 兜底。
 *  2. **不维护内存索引**：`list / get / children / ...` 当场 readdirSync。
 *     扫一棵小树几十微秒，远低于内存模型 vs 文件系统同步带来的 bug 成本。
 *  3. **fs 事件走项目 `FSWatcher`**：监听 agents/ 子树（recursive），收到
 *     rename 事件后用 `existsSync + isValidAgentPath` 判定是 added 还是
 *     removed，派发给 `onChange` 订阅者（Scheduler 用它做 attach/detach）。
 *     **不**用 chokidar，**不**裸调 `node:fs.watch`，统一走 `FSWatcher` 的
 *     引用计数 / debounce / ownerId 释放。 */

import { existsSync, readdirSync, lstatSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AgentNode, AgentTreeAPI, TreeChange } from "../core/types";
import type { PathManagerAPI } from "../fs/types";
import type { FSWatcherAPI, WatchRegistration } from "../fs/types";
import { createOrGetFSWatcher } from "../fs/watcher";
import { isValidAgentPath } from "./agent-scaffold";

export class AgentTree implements AgentTreeAPI {
  private readonly agentsRoot: string;
  private readonly fsWatcher: FSWatcherAPI;
  private readonly ownerId: string;
  private watchReg: WatchRegistration | null = null;
  private listeners = new Set<(changes: TreeChange[]) => void>();

  constructor(
    public readonly sid: string,
    paths: PathManagerAPI,
    fsWatcher?: FSWatcherAPI,
  ) {
    this.agentsRoot = paths.session(sid).agentsDir();
    this.fsWatcher = fsWatcher ?? createOrGetFSWatcher();
    this.ownerId = `agent-tree:${sid}`;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** 启 fs-watcher 监听 agents/ 子树（recursive）。listener 注册前都不会派
   *  发任何 onChange 事件，但 list/get 任何时候都能直接 readdir 返回。 */
  init(): void {
    // fs.watch 监听不存在路径会 ENOENT —— sm.create 时 agents/ 还没建，提前
    // 兜底 mkdir 一层，让 inotify 从一开始就盯准它。
    mkdirSync(this.agentsRoot, { recursive: true });

    this.watchReg = this.fsWatcher.watchDir(
      this.agentsRoot,
      (event) => this._onFsEvent(event.path),
      { ownerId: this.ownerId },
    );
  }

  async dispose(): Promise<void> {
    if (this.watchReg) {
      this.watchReg.dispose();
      this.watchReg = null;
    }
    this.fsWatcher.unregisterOwner(this.ownerId);
    this.listeners.clear();
  }

  // ─── Query API（每次现场 readdir）─────────────────────────────────────

  list(): AgentNode[] {
    if (!existsSync(this.agentsRoot)) return [];
    const out: AgentNode[] = [];
    walkAgentDirs(this.agentsRoot, this.agentsRoot, (logicalPath) => {
      out.push(makeNode(logicalPath));
    });
    return out;
  }

  get(path: string): AgentNode | undefined {
    const norm = normalizeAgentPath(path);
    if (!norm) return undefined;
    const dir = join(this.agentsRoot, norm);
    let stat;
    try { stat = lstatSync(dir); } catch { return undefined; }
    if (!stat.isDirectory()) return undefined;
    return makeNode(norm);
  }

  getByFullId(fullId: string): AgentNode | undefined {
    return this.list().find((n) => n.fullId === fullId);
  }

  /** Friendly lookup by display name. 重名时报错（caller 应回退到 fullId）。 */
  findByDisplay(display: string): AgentNode {
    const matches = this.list().filter((n) => n.display === display);
    if (matches.length === 0) {
      throw new Error(`AgentTree: no agent with display='${display}'`);
    }
    if (matches.length > 1) {
      const ids = matches.map((n) => n.fullId).join(", ");
      throw new Error(`AgentTree: ambiguous display='${display}' (candidates: ${ids}); use fullId`);
    }
    return matches[0]!;
  }

  parent(path: string): AgentNode | undefined {
    const node = this.get(path);
    if (!node?.parent) return undefined;
    return this.get(node.parent);
  }

  children(path: string): AgentNode[] {
    const norm = normalizeAgentPath(path);
    return this.list().filter((n) => n.parent === norm);
  }

  /** Tree-derived 可写路径：自身 + 直接子 agent + 共享 workspace。 */
  getWritablePaths(path: string): string[] {
    const node = this.get(path);
    if (!node) return [];
    const out: string[] = [];
    out.push(`${node.path}/`);
    for (const child of this.children(node.path)) {
      out.push(`${child.path}/`);
    }
    out.push("shared-workspace/");
    return out;
  }

  // ─── onChange ─────────────────────────────────────────────────────────

  /** 订阅 add/remove 事件。Scheduler 用它做自动 attach/detach；前端通过
   *  WS 桥也可以挂在这上。返回 unsubscribe。 */
  onChange(handler: (changes: TreeChange[]) => void): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private _onFsEvent(relPath: string): void {
    // FSWatcher 事件 path 已经 normalized 成 "/" 分隔。fs.watch 看到的所有
    // 改动都进这里：agent 目录 add/del、agent.json 写入、kits/blobs/events
    // 内的文件变更都会派发。我们只关心"目录形态恰好是合法 agent path"的
    // 情况；其它变更对 tree 拓扑无意义，直接 ignore。
    if (!relPath || !isValidAgentPath(relPath)) return;

    const abs = join(this.agentsRoot, relPath);
    const present = isExistingDir(abs);
    const node = makeNode(relPath);
    const change: TreeChange = present
      ? { kind: "added", node }
      : { kind: "removed", node };

    for (const cb of this.listeners) {
      try { cb([change]); } catch (err) {
        process.stderr.write(`[agent-tree] listener error: ${(err as Error).message}\n`);
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function normalizeAgentPath(p: string): string {
  return p.split(sep).join("/").replace(/^\/+|\/+$/g, "");
}

function makeNode(path: string): AgentNode {
  const segs = path.split("/").filter(Boolean);
  const display = segs[segs.length - 1] ?? "";
  const depth = segs.length;
  const parent = segs.length > 1 ? segs.slice(0, -1).join("/") : undefined;
  return { path, display, depth, fullId: `${display}#${depth}`, parent };
}

function isExistingDir(abs: string): boolean {
  try { return lstatSync(abs).isDirectory(); } catch { return false; }
}

/** 套娃式扫盘：在 `agentsDir` 下，每个子目录 `<name>/` 视为一个 agent；如果
 *  它自己也含 `agents/` 子目录，递归进去当作子 agent。其它目录（events/、
 *  kits/、logs/ 等）不是子 agent，由"只下钻 agents/"逻辑自然排除。 */
function walkAgentDirs(
  root: string,
  curAgentsDir: string,
  visit: (logicalPath: string) => void,
): void {
  let names: string[];
  try {
    names = readdirSync(curAgentsDir);
  } catch { return; }

  for (const name of names) {
    if (name.startsWith(".")) continue;
    const agentDir = join(curAgentsDir, name);
    let stat;
    try { stat = lstatSync(agentDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const rel = relative(root, agentDir);
    if (rel) visit(normalizeAgentPath(rel));

    const childAgentsDir = join(agentDir, "agents");
    if (existsSync(childAgentsDir)) {
      walkAgentDirs(root, childAgentsDir, visit);
    }
  }
}
