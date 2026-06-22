import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { TeamBoardAPI, TeamBoardSetOptions, WatchCallback, FSWatcherAPI } from "./types.js";

export class TeamBoard implements TeamBoardAPI {
  private boards = new Map<string, Map<string, unknown>>();
  private persistedKeys = new Map<string, Set<string>>();
  private watchers = new Map<string, Map<string, Set<WatchCallback>>>();
  private filePath: string;
  private lastWriteTs = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

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
    } catch { /* corrupted or missing — start fresh */ }
  }

  registerFSWatcher(fsWatcher: FSWatcherAPI): void {
    fsWatcher.unregisterOwner("teamboard");
    fsWatcher.watchFile(this.filePath, () => {
      if (Date.now() - this.lastWriteTs < 500) return;
      this.reloadFromDisk();
    }, { ownerId: "teamboard" });
  }

  set(agentId: string, key: string, value: unknown, options?: TeamBoardSetOptions): void {
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

  getAll(agentId: string): Record<string, unknown> {
    const board = this.boards.get(agentId);
    if (!board) return {};
    return Object.fromEntries(board);
  }

  agentIds(): string[] {
    return [...this.boards.keys()];
  }

  removeByPrefix(prefix: string): void {
    for (const agentId of [...this.boards.keys()]) {
      if (agentId.startsWith(prefix)) {
        this.removeAll(agentId);
      }
    }
  }

  removeAll(agentId: string): void {
    const board = this.boards.get(agentId);
    if (!board) return;
    const hadPersisted = (this.persistedKeys.get(agentId)?.size ?? 0) > 0;

    const agentWatchers = this.watchers.get(agentId);
    for (const [key, prev] of board) {
      const keyWatchers = agentWatchers?.get(key);
      if (keyWatchers) {
        for (const cb of keyWatchers) {
          try { cb(undefined, prev); } catch { /* watcher error */ }
        }
      }
    }

    this.boards.delete(agentId);
    this.persistedKeys.delete(agentId);
    this.watchers.delete(agentId);
    if (hadPersisted) this.writeToDisk();
  }

  watch(agentId: string, key: string, cb: WatchCallback): () => void {
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
      try { cb(value, prev); } catch { /* watcher error */ }
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
      this.lastWriteTs = Date.now();
    } catch { /* write failed — non-critical */ }
  }

  private reloadFromDisk(): void {
    let data: Record<string, Record<string, unknown>>;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const allAgentIds = new Set([...this.boards.keys(), ...Object.keys(data)]);

    for (const agentId of allAgentIds) {
      const diskEntries = data[agentId] ?? {};
      const memBoard = this.boards.get(agentId);
      const persisted = this.persistedKeys.get(agentId) ?? new Set<string>();
      const memEntries = memBoard
        ? Object.fromEntries([...memBoard.entries()].filter(([key]) => persisted.has(key)))
        : {};

      const allKeys = new Set([...Object.keys(diskEntries), ...Object.keys(memEntries)]);
      for (const key of allKeys) {
        const diskVal = diskEntries[key];
        const memVal = memEntries[key];
        if (JSON.stringify(diskVal) !== JSON.stringify(memVal)) {
          if (diskVal === undefined) {
            const board = this.boards.get(agentId);
            if (board) {
              board.delete(key);
              this.persistedKeys.get(agentId)?.delete(key);
              if (board.size === 0) this.boards.delete(agentId);
            }
          } else {
            let board = this.boards.get(agentId);
            if (!board) {
              board = new Map();
              this.boards.set(agentId, board);
            }
            board.set(key, diskVal);
            let persistedSet = this.persistedKeys.get(agentId);
            if (!persistedSet) {
              persistedSet = new Set();
              this.persistedKeys.set(agentId, persistedSet);
            }
            persistedSet.add(key);
          }
          this.fireWatchers(agentId, key, diskVal, memVal);
        }
      }
    }
  }
}
