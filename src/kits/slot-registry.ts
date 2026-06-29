/** SlotRegistry — stores ContextSlot; exposes raw slot list for assembly.
 *
 *  Skeleton stub. Full impl will mirror agenteam-os-ref/src/registries
 *  (DynamicSlotAPI for runtime slot injection from tools/plugins).
 *  TODO: port runtime slot injection (`register/release` with resolved string
 *  content; see ref BaseRegistry<ContextSlot, string>). */

import type { SlotRegistryAPI } from "../core/types";
import { BaseRegistry } from "./base-registry";
import type { ContextSlot } from "./slot/types";

export class SlotRegistry extends BaseRegistry<ContextSlot> implements SlotRegistryAPI {
  replaceStatic(slots: Map<string, ContextSlot>): void {
    this.replaceStaticItems(slots);
  }

  get(key: string): ContextSlot | undefined {
    const resolved = this.resolveKey(key);
    if (resolved === undefined) return undefined;
    return this.dynamicItems.get(resolved) ?? this.staticItems.get(resolved);
  }

  /** Snapshot of all slots (used by assembleSystemBlocks). */
  list(): ContextSlot[] {
    return this.all();
  }
}
