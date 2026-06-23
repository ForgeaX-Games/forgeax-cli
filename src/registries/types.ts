import type { ContextSlot } from "../capability/slot/types.js";
export interface SlotRegistryView {
  all(): ContextSlot[];
}
