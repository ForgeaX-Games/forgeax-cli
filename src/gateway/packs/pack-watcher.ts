/** @desc PackWatcher — two-tier non-recursive watch over packsDir.
 *
 *  L1: `packsDir/` (non-recursive)
 *    - pack dir create/delete → reconcileRoot()
 *    - reconcileRoot syncs the per-pack L2 watcher set + ensurePackCompleteness
 *      for every present pack
 *
 *  L2: `<packDir>/agents/` (non-recursive, one per pack)
 *    - agent dir create/delete → reconcilePack(packId)
 *    - reconcilePack just ensurePackCompleteness on that one pack (which itself
 *      rebuilds agent-tree.json from agents/ contents)
 *
 *  Total inotify usage: 1 + N (N = pack count), down from recursive ~1455.
 *  Pack-internal capabilities/, startup-scripts/, agent dir contents
 *  (SOUL/PRINCIPLE/agent.json) are intentionally NOT watched here — instance
 *  load paths handle those separately.
 */

import { watch, type FSWatcher, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ensurePackCompleteness, isValidPackId } from "./pack-scaffold.js";

const DEBOUNCE_MS = 300;

export class PackWatcher {
  private rootWatcher: FSWatcher | null = null;
  private packWatchers = new Map<string, FSWatcher>();        // packId -> agents/ watcher
  private rootTimer: ReturnType<typeof setTimeout> | null = null;
  private packTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly packsDir: string) {}

  async start(): Promise<void> {
    if (!existsSync(this.packsDir)) return;
    try {
      this.rootWatcher = watch(this.packsDir, { persistent: false }, () => this.scheduleRoot());
    } catch (err) {
      console.warn("[PackWatcher] Failed to watch packsDir:", err);
    }
    await this.reconcileRoot();
  }

  stop(): void {
    this.rootWatcher?.close();
    this.rootWatcher = null;
    for (const w of this.packWatchers.values()) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.packWatchers.clear();
    if (this.rootTimer) clearTimeout(this.rootTimer);
    this.rootTimer = null;
    for (const t of this.packTimers.values()) clearTimeout(t);
    this.packTimers.clear();
  }

  // ─── L1: packsDir 第一层变化 ───────────────────────────────────────

  private scheduleRoot(): void {
    if (this.rootTimer) return;
    this.rootTimer = setTimeout(() => {
      this.rootTimer = null;
      void this.reconcileRoot();
    }, DEBOUNCE_MS);
  }

  private async reconcileRoot(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.packsDir, { withFileTypes: true });
    } catch (err) {
      console.warn("[PackWatcher] reconcileRoot failed:", err);
      return;
    }

    const present = new Set<string>();
    for (const e of entries) {
      if (!e.isDirectory() || !isValidPackId(e.name)) continue;
      present.add(e.name);
      if (!this.packWatchers.has(e.name)) this.attachPackWatcher(e.name);
      void this.reconcilePack(e.name);
    }
    // pack 被删 → 卸 watcher
    for (const packId of [...this.packWatchers.keys()]) {
      if (!present.has(packId)) this.detachPackWatcher(packId);
    }
  }

  // ─── L2: per-pack `agents/` 第一层变化 ─────────────────────────────

  private attachPackWatcher(packId: string): void {
    const agentsDir = join(this.packsDir, packId, "agents");
    // agents/ 可能还不存在；ensurePackCompleteness 会创建它，watch 推迟到目录在
    if (!existsSync(agentsDir)) return;
    try {
      const w = watch(agentsDir, { persistent: false }, () => this.schedulePack(packId));
      this.packWatchers.set(packId, w);
    } catch (err) {
      console.warn(`[PackWatcher] Failed to watch ${packId}/agents/:`, err);
    }
  }

  private detachPackWatcher(packId: string): void {
    const w = this.packWatchers.get(packId);
    if (w) {
      try { w.close(); } catch { /* ignore */ }
      this.packWatchers.delete(packId);
    }
    const t = this.packTimers.get(packId);
    if (t) { clearTimeout(t); this.packTimers.delete(packId); }
  }

  private schedulePack(packId: string): void {
    if (this.packTimers.has(packId)) return;
    const t = setTimeout(() => {
      this.packTimers.delete(packId);
      void this.reconcilePack(packId);
    }, DEBOUNCE_MS);
    this.packTimers.set(packId, t);
  }

  private async reconcilePack(packId: string): Promise<void> {
    try {
      await ensurePackCompleteness(join(this.packsDir, packId), packId);
    } catch (err) {
      console.warn(`[PackWatcher] reconcile '${packId}' failed:`, err);
      return;
    }
    // 第一次 ensurePackCompleteness 会创建 agents/，补挂 L2 watcher
    if (!this.packWatchers.has(packId)) this.attachPackWatcher(packId);
  }
}
