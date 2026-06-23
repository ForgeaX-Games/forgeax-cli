/** FSWatcher — on-demand inotify slot manager (no implicit root watch).
 *
 *  Ported from agenteam-os-ref/src/fs/watcher.ts.
 *
 *  API: caller provides an absolute path; watchFile / watchDir each lease an
 *  inotify slot keyed by the actual fs.watch target + recursiveness. Slots are
 *  reference-counted; when the last subscriber disposes, the underlying
 *  fs.watch handle is closed.
 *
 *  Atomic-rename safety: watchFile internally watches the parent directory
 *  (non-recursive) and filters events by basename. fs.watch on a single file
 *  loses its association after editors do create-temp + rename. */

import { watch, type FSWatcher as NodeFSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { FSWatcherAPI, WatchRegistration, FSChangeEvent, FSHandler } from "./types";

let _instance: FSWatcher | null = null;

export function getFSWatcher(): FSWatcher | null {
  return _instance;
}

export function createOrGetFSWatcher(): FSWatcher {
  if (!_instance) _instance = new FSWatcher();
  return _instance;
}

const DEFAULT_DEBOUNCE_MS = 300;
let nextId = 0;

interface Subscriber {
  id: string;
  ownerId?: string;
  filter?: (filename: string) => boolean;
  handler: FSHandler;
  debounceMs: number;
}

interface Slot {
  watchPath: string;
  recursive: boolean;
  handle: NodeFSWatcher | null;
  refCount: number;
  subscribers: Map<string, Subscriber>;
}

function slotKey(watchPath: string, recursive: boolean): string {
  return `${watchPath}|${recursive ? "R" : "N"}`;
}

export class FSWatcher implements FSWatcherAPI {
  private slots = new Map<string, Slot>();
  private regIndex = new Map<string, string>();
  private owners = new Map<string, Set<string>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  watchFile(
    absPath: string,
    handler: () => void,
    opts?: { debounceMs?: number; ownerId?: string },
  ): WatchRegistration {
    const parent = dirname(absPath);
    const base = basename(absPath);
    return this._subscribe(parent, false, {
      ownerId: opts?.ownerId,
      filter: (filename) => filename === base,
      handler: () => handler(),
      debounceMs: opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    });
  }

  watchDir(
    absPath: string,
    handler: FSHandler,
    opts?: { debounceMs?: number; ownerId?: string; pattern?: RegExp },
  ): WatchRegistration {
    const pattern = opts?.pattern;
    return this._subscribe(absPath, true, {
      ownerId: opts?.ownerId,
      filter: pattern ? (filename) => pattern.test(filename.split(/[\\/]/).join("/")) : undefined,
      handler,
      debounceMs: opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    });
  }

  unregisterOwner(ownerId: string): void {
    const ids = this.owners.get(ownerId);
    if (!ids) return;
    for (const id of [...ids]) this._disposeReg(id);
  }

  close(): void {
    for (const slot of this.slots.values()) {
      try { slot.handle?.close(); } catch { /* ignore */ }
    }
    this.slots.clear();
    this.regIndex.clear();
    this.owners.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (_instance === this) _instance = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private _subscribe(watchPath: string, recursive: boolean, sub: Omit<Subscriber, "id">): WatchRegistration {
    const key = slotKey(watchPath, recursive);
    let slot = this.slots.get(key);
    if (!slot) slot = this._openSlot(watchPath, recursive, key);

    const id = `watch_${++nextId}`;
    slot.subscribers.set(id, { id, ...sub });
    slot.refCount++;
    this.regIndex.set(id, key);

    if (sub.ownerId) {
      let owned = this.owners.get(sub.ownerId);
      if (!owned) { owned = new Set(); this.owners.set(sub.ownerId, owned); }
      owned.add(id);
    }

    return { id, dispose: () => this._disposeReg(id) };
  }

  private _openSlot(watchPath: string, recursive: boolean, key: string): Slot {
    let handle: NodeFSWatcher | null = null;
    try {
      handle = watch(watchPath, recursive ? { recursive: true } : {});
      handle.on("change", (event, filename) => {
        const name = typeof filename === "string" ? filename : filename?.toString() ?? "";
        this._dispatch(key, event, name);
      });
      handle.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EACCES" || err.code === "EPERM" || err.code === "ENOENT") return;
        process.stderr.write(`[FSWatcher] watch error for ${watchPath}: ${err.message}\n`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[FSWatcher] watch failed for ${watchPath}: ${msg}\n`);
      handle = null;
    }
    const slot: Slot = { watchPath, recursive, handle, refCount: 0, subscribers: new Map() };
    this.slots.set(key, slot);
    return slot;
  }

  private _disposeReg(id: string): void {
    const key = this.regIndex.get(id);
    if (!key) return;
    this.regIndex.delete(id);
    const slot = this.slots.get(key);
    if (!slot) return;
    const sub = slot.subscribers.get(id);
    if (sub?.ownerId) {
      const owned = this.owners.get(sub.ownerId);
      if (owned) { owned.delete(id); if (owned.size === 0) this.owners.delete(sub.ownerId); }
    }
    slot.subscribers.delete(id);
    slot.refCount--;
    if (slot.refCount <= 0) {
      try { slot.handle?.close(); } catch { /* ignore */ }
      this.slots.delete(key);
    }
    for (const tkey of [...this.timers.keys()]) {
      if (tkey.startsWith(id + ":")) {
        clearTimeout(this.timers.get(tkey)!);
        this.timers.delete(tkey);
      }
    }
  }

  private _dispatch(key: string, eventType: string, filename: string): void {
    if (!filename) return;
    const slot = this.slots.get(key);
    if (!slot) return;
    const normalized = filename.split(/[\\/]/).join("/");
    for (const sub of slot.subscribers.values()) {
      if (sub.filter && !sub.filter(normalized)) continue;

      const debounceKey = `${sub.id}:${normalized}`;
      const existing = this.timers.get(debounceKey);
      if (existing) clearTimeout(existing);

      const fsEvent: FSChangeEvent = {
        type: eventType === "rename" ? "rename" : "modify",
        path: normalized,
        isDir: false,
      };

      const timer = setTimeout(() => {
        this.timers.delete(debounceKey);
        try { sub.handler(fsEvent); } catch { /* consumer error */ }
      }, sub.debounceMs);

      this.timers.set(debounceKey, timer);
    }
  }
}
