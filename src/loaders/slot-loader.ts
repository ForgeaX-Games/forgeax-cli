import type { ContextSlot, SlotFactory, SlotContext } from "../capability/slot/types.js";
import type { AgentContext } from "../core/types.js";
import { BaseLoader } from "./base-loader.js";

type SlotModule = {
  default: SlotFactory;
};

/**
 * Stateless slot loader.
 *
 * Slots are re-evaluated every prompt assembly turn — `content()` is sync
 * and runs fresh, so file-backed slots see new content automatically. Slots
 * that want to skip redundant disk reads should track mtime inside their
 * own closure (see ref_slot_authoring.md). The previous declarative `watch`
 * mechanism has been removed; capability-source hot reload is handled by
 * AgentReloadCoordinator's polling on capabilities/.
 */
export class SlotLoader extends BaseLoader<SlotModule, ContextSlot> {
  protected readonly kind = "slots" as const;
  private slotCtx: SlotContext | null = null;

  setSlotContext(ctx: SlotContext): void {
    this.slotCtx = ctx;
  }

  createInstance(
    factory: SlotModule,
    _ctx: AgentContext,
    name: string,
  ): ContextSlot | null {
    if (typeof factory.default !== "function") return null;
    if (!this.slotCtx) {
      throw new Error(`[SlotLoader] setSlotContext must be called before loading slot "${name}"`);
    }
    return factory.default(this.slotCtx);
  }

  async load(ctx: AgentContext): Promise<Map<string, ContextSlot>> {
    return this.loadOnce(ctx);
  }
}
