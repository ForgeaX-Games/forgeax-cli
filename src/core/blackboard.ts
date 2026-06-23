/** Per-session 反应式 KV —— agentId 命名空间。
 *
 *  Plan §2.3 范式（与 agenteam team-board.ts 的差异）：
 *  - **单向内存→盘**：不注册 FS watcher，没有 reloadFromDisk + diff。文件仅
 *    用作「启动加载」+「写穿快照」，砍掉双向依赖。这是 agenteam 实践证明的简化点：
 *    几乎从不外部直改文件，反向 reload 是死代码。
 *  - **persist 默认 true**：与 agenteam 一致；调用方显式 `persist: false` 才走纯内存。
 *    per-key 维护 `persistedKeys`，写盘时只序列化 persisted 子集。
 *  - **写盘策略**：set / remove 触发 persisted 变化 → 同步立即全量重写
 *    `<sid>/blackboard.json`。黑板量级小，无需 WAL / 节流。
 *  - **回放**：Session 构造期 loadFromDisk() 一次全量；持久化 key 自动恢复，
 *    瞬时 key 自然丢失。
 *
 *  作用域语义：跨 agent 共享 = 「指定 owner agentId」，例如 orchestrator 把
 *  `set("orchestrator", "workflow_phase", x)`，其它 agent 读 `get("orchestrator", ...)`，
 *  仍可 watch。不开「全局 key」通道，避免 ACL / 命名空间复杂化。 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  BlackboardAPI,
  BlackboardSetOptions,
  BlackboardWatch,
} from "./types";

export class Blackboard implements BlackboardAPI {
  private boards = new Map<string, Map<string, unknown>>();
  private persistedKeys = new Map<string, Set<string>>();
  private watchers = new Map<string, Map<string, Set<BlackboardWatch>>>();

  constructor(private readonly filePath: string) {}

  loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      for (const [agentId, entries] of Object.entries(data)) {
        const board = new Map<string, unknown>();
        const persisted = new Set<string>();
        for (const [k, v] of Object.entries(entries)) {
          board.set(k, v);
          persisted.add(k);
        }
        this.boards.set(agentId, board);
        this.persistedKeys.set(agentId, persisted);
      }
    } catch { /* corrupted JSON — start fresh */ }
  }

  flush(): void {
    this.writeToDisk();
  }

  set(agentId: string, key: string, value: unknown, options?: BlackboardSetOptions): void {
    let board = this.boards.get(agentId);
    if (!board) {
      board = new Map();
      this.boards.set(agentId, board);
    }
    let persisted = this.persistedKeys.get(agentId);
    if (!persisted) {
      persisted = new Set();
      this.persistedKeys.set(agentId, persisted);
    }

    const prev = board.get(key);
    const wasPersisted = persisted.has(key);
    board.set(key, value);
    if (options?.persist === false) {
      persisted.delete(key);
    } else {
      persisted.add(key);
    }
    this.fireWatchers(agentId, key, value, prev);
    // 如果当前写持久化 / 之前是持久化（要从盘上删掉它），都需要落盘。
    if (options?.persist !== false || wasPersisted) {
      this.writeToDisk();
    }
  }

  get(agentId: string, key: string): unknown {
    return this.boards.get(agentId)?.get(key);
  }

  remove(agentId: string, key: string): void {
    const board = this.boards.get(agentId);
    if (!board) return;
    const prev = board.get(key);
    const persisted = this.persistedKeys.get(agentId);
    const wasPersisted = persisted?.has(key) ?? false;
    board.delete(key);
    persisted?.delete(key);
    this.fireWatchers(agentId, key, undefined, prev);
    if (board.size === 0) {
      this.boards.delete(agentId);
      this.persistedKeys.delete(agentId);
    }
    if (wasPersisted) this.writeToDisk();
  }

  removeAll(agentId: string): void {
    const board = this.boards.get(agentId);
    if (!board) return;
    const hadPersisted = (this.persistedKeys.get(agentId)?.size ?? 0) > 0;

    // 触发 watcher 拿到 undefined（与 remove 单 key 行为一致）。
    const agentWatchers = this.watchers.get(agentId);
    for (const [key, prev] of board) {
      const keyWatchers = agentWatchers?.get(key);
      if (keyWatchers) {
        for (const cb of keyWatchers) {
          try { cb(undefined, prev); } catch { /* watcher error swallowed */ }
        }
      }
    }

    this.boards.delete(agentId);
    this.persistedKeys.delete(agentId);
    this.watchers.delete(agentId);
    if (hadPersisted) this.writeToDisk();
  }

  removeByPrefix(prefix: string): void {
    for (const agentId of [...this.boards.keys()]) {
      if (agentId.startsWith(prefix)) {
        this.removeAll(agentId);
      }
    }
  }

  getAll(agentId: string): Record<string, unknown> {
    const board = this.boards.get(agentId);
    if (!board) return {};
    return Object.fromEntries(board);
  }

  agentIds(): string[] {
    return [...this.boards.keys()];
  }

  watch(agentId: string, key: string, cb: BlackboardWatch): () => void {
    let agentWatchers = this.watchers.get(agentId);
    if (!agentWatchers) {
      agentWatchers = new Map();
      this.watchers.set(agentId, agentWatchers);
    }
    let keyWatchers = agentWatchers.get(key);
    if (!keyWatchers) {
      keyWatchers = new Set();
      agentWatchers.set(key, keyWatchers);
    }
    keyWatchers.add(cb);

    return () => {
      keyWatchers!.delete(cb);
      if (keyWatchers!.size === 0) agentWatchers!.delete(key);
      if (agentWatchers!.size === 0) this.watchers.delete(agentId);
    };
  }

  private fireWatchers(agentId: string, key: string, value: unknown, prev: unknown): void {
    const keyWatchers = this.watchers.get(agentId)?.get(key);
    if (!keyWatchers) return;
    for (const cb of keyWatchers) {
      try { cb(value, prev); } catch { /* watcher error swallowed */ }
    }
  }

  private writeToDisk(): void {
    const data: Record<string, Record<string, unknown>> = {};
    for (const [agentId, board] of this.boards) {
      const persisted = this.persistedKeys.get(agentId);
      if (!persisted || persisted.size === 0) continue;
      const entries = [...board.entries()].filter(([key]) => persisted.has(key));
      if (entries.length > 0) data[agentId] = Object.fromEntries(entries);
    }
    try {
      writeFileSync(this.filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    } catch { /* write failed — non-critical, in-memory state still authoritative */ }
  }
}
