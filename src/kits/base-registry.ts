/** BaseRegistry<T, TGet> — dual-Map (static + dynamic) registry skeleton.
 *
 *  Static items are managed by loaders (file discovery + hot-reload).
 *  Dynamic items are managed at runtime by tools/plugins via their DynamicAPI.
 *
 *  Items are stored under qualified `kit/kind/name`. `get()` accepts either
 *  the qualified key or its bare last segment when unambiguous —
 *  see `name-lookup.ts` for the resolution policy.
 *
 *  Ported from agenteam-os-ref/src/registries/base-registry.ts. */

import { bareName } from "./name-lookup";
import type { ReplaceDiff } from "./types";

export abstract class BaseRegistry<T, TGet = T> {
  protected staticItems = new Map<string, T>();
  protected dynamicItems = new Map<string, T>();

  abstract get(key: string): TGet | undefined;

  /** Resolve `name` (qualified or bare-when-unique) to the actual stored key.
   *  Returns undefined when bare-name match is ambiguous or absent. */
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

  /** All items, dedup — dynamic overrides static on same key. */
  all(): T[] {
    const merged = new Map(this.staticItems);
    for (const [k, v] of this.dynamicItems) merged.set(k, v);
    return [...merged.values()];
  }

  patchStatic(key: string, item: T): T | undefined {
    const prev = this.staticItems.get(key);
    if (prev === item) return undefined;
    this.staticItems.set(key, item);
    return prev;
  }

  removeStatic(key: string): T | undefined {
    const prev = this.staticItems.get(key);
    if (prev !== undefined) this.staticItems.delete(key);
    return prev;
  }

  clear(): void {
    this.staticItems.clear();
    this.dynamicItems.clear();
  }

  /** Replace static items with reference-equality diff. Content-hash ESM
   *  cache keys (`?v=sha1`) guarantee unchanged modules return the same
   *  object reference, so `!==` reliably detects actual file changes. */
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
