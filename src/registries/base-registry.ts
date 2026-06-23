/**
 * BaseRegistry<T, TGet> — dual-Map (static + dynamic) registry skeleton.
 *
 * Static items are managed by loaders (file discovery / hot-reload).
 * Dynamic items are managed at runtime by tools/plugins via the DynamicAPI.
 *
 * Items are stored under their **qualified name** (`pkg/kind/name`). The
 * `get()` method accepts either a qualified name or its bare last segment
 * when that bare name is unambiguous across the registry — see
 * `name-lookup.ts` for the resolution policy. This matches the LLM-facing
 * displayName convention (bare-when-unique, qualified-when-conflict) so
 * names round-tripped through the LLM hit the registry without per-caller
 * translation.
 *
 * @typeParam T    — internal storage type
 * @typeParam TGet — return type of `get()`. Defaults to T.
 *                   SlotRegistry stores ContextSlot internally but exposes
 *                   resolved `string` content via DynamicSlotAPI, so it
 *                   specifies TGet = string.
 */

import { bareName } from "./name-lookup.js";

export interface ReplaceDiff {
  readonly added: Set<string>;
  readonly removed: Set<string>;
  readonly changed: Set<string>;
  readonly dirty: boolean;
}

export abstract class BaseRegistry<T, TGet = T> {
  protected staticItems = new Map<string, T>();
  protected dynamicItems = new Map<string, T>();

  abstract get(key: string): TGet | undefined;

  /**
   * Resolve `name` (qualified or bare-when-unique) to the actual stored
   * qualified key. Subclasses use this in their `get()` to look up by either
   * form. Returns undefined when bare-name match is ambiguous or absent.
   */
  protected resolveKey(name: string): string | undefined {
    if (this.dynamicItems.has(name) || this.staticItems.has(name)) return name;
    let found: string | undefined;
    for (const m of [this.dynamicItems, this.staticItems]) {
      for (const k of m.keys()) {
        if (bareName(k) !== name) continue;
        if (found !== undefined && found !== k) return undefined;
        found = k;
      }
    }
    return found;
  }

  /** All items, deduplicated — dynamic overrides static on same key. */
  all(): T[] {
    const merged = new Map(this.staticItems);
    for (const [k, v] of this.dynamicItems) merged.set(k, v);
    return [...merged.values()];
  }

  /**
   * Update or add a single static item. Returns the previous item if replaced.
   * Subclasses override to add lifecycle (plugin stop/start, tool notify).
   */
  patchStatic(key: string, item: T): T | undefined {
    const prev = this.staticItems.get(key);
    if (prev === item) return undefined;
    this.staticItems.set(key, item);
    return prev;
  }

  /**
   * Remove a single static item. Returns the removed item, or undefined if absent.
   * Subclasses override to add lifecycle (plugin stop).
   */
  removeStatic(key: string): T | undefined {
    const prev = this.staticItems.get(key);
    if (prev !== undefined) this.staticItems.delete(key);
    return prev;
  }

  clear(): void {
    this.staticItems.clear();
    this.dynamicItems.clear();
  }

  /**
   * Replace static items with reference-equality diff.
   *
   * Content-hash ESM cache keys (`?v=sha1`) guarantee that unchanged
   * modules return the same object reference, so `!==` reliably detects
   * actual file changes.
   *
   * Returns which items were added, removed, or changed. Subclasses
   * use this to drive lifecycle (plugin stop/start) or change notifications.
   */
  protected replaceStaticItems(incoming: Map<string, T>): ReplaceDiff {
    const added = new Set<string>();
    const removed = new Set<string>();
    const changed = new Set<string>();

    for (const [name, old] of this.staticItems) {
      if (!incoming.has(name)) removed.add(name);
      else if (incoming.get(name) !== old) changed.add(name);
    }
    for (const name of incoming.keys()) {
      if (!this.staticItems.has(name)) added.add(name);
    }

    this.staticItems = incoming;
    return { added, removed, changed, dirty: added.size + removed.size + changed.size > 0 };
  }
}
