import type { DynamicSlotAPI } from "../core/types.js";
import type { ContextSlot } from "../capability/slot/types.js";
import type { SlotRegistryView } from "./types.js";
import { BaseRegistry } from "./base-registry.js";

export class SlotRegistry extends BaseRegistry<ContextSlot, string> implements DynamicSlotAPI, SlotRegistryView {

  replaceStatic(slots: Map<string, ContextSlot>): { dirty: boolean } {
    return this.replaceStaticItems(slots);
  }

  register(id: string, content: string): void {
    this.dynamicItems.set(id, {
      name: id,
      priority: 100,
      content,
      version: 0,
    });
  }

  update(id: string, content: string): void {
    const slot = this.dynamicItems.get(id);
    if (slot) {
      slot.content = content;
      slot.version++;
    }
  }

  release(id: string): void {
    this.dynamicItems.delete(id);
  }

  /** DynamicSlotAPI.get — returns resolved string content (not ContextSlot). */
  get(id: string): string | undefined {
    const resolved = this.resolveKey(id);
    if (resolved === undefined) return undefined;
    const slot = this.dynamicItems.get(resolved) ?? this.staticItems.get(resolved);
    if (!slot) return undefined;
    return typeof slot.content === "function" ? slot.content() : slot.content;
  }

  /** DynamicSlotAPI.list — returns resolved string contents. */
  list(): string[] {
    const merged = new Map(this.staticItems);
    for (const [k, v] of this.dynamicItems) merged.set(k, v);
    return [...merged.values()].map((slot) =>
      typeof slot.content === "function" ? slot.content() : slot.content,
    ).filter((content): content is string => typeof content === "string");
  }
}
