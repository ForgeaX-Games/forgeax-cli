/** KitSlotLoader —— stateless slot kit loader.
 *
 *  Slots are re-evaluated every prompt assembly turn — `content()` is sync
 *  and runs fresh, so file-backed slots see new content automatically.
 *  Slot-source hot reload (the file itself changing) flows through
 *  AgentKitReloadCoordinator (B1.10), which calls `load(ctx)` again on each
 *  changed kit dir.
 *
 *  Ported from `agenteam-os-ref/src/loaders/slot-loader.ts`. */

import type { AgentContext } from "../core/types";
import type { ContextSlot } from "./slot/types";
import type { SlotFactory } from "./types";
import { BaseKitLoader } from "./base-loader";

type SlotModule = { default?: SlotFactory };

export class KitSlotLoader extends BaseKitLoader<SlotModule, ContextSlot | null> {
  protected readonly kind = "slots" as const;
  private slotCtx: AgentContext | null = null;

  /** Plumb in agentContext — required because `factory(ctx)` is called from
   *  inside `createInstance`, which BaseKitLoader doesn't pass agentContext
   *  to directly (sticks to the factory contract). */
  setSlotContext(ctx: AgentContext): void {
    this.slotCtx = ctx;
  }

  createInstance(
    factory: SlotModule,
    _ctx: AgentContext,
    name: string,
  ): ContextSlot | null {
    if (typeof factory.default !== "function") return null;
    if (!this.slotCtx) {
      throw new Error(`[KitSlotLoader] setSlotContext must be called before loading slot "${name}"`);
    }
    try {
      const slot = factory.default(this.slotCtx);
      if (!slot || typeof slot !== "object") return null;
      // 校验最少字段：name + content + priority。其它字段（cacheHint /
      // condition）有缺省值，prompt-pipeline 自己兜底。
      if (typeof slot.name !== "string") return null;
      if (slot.content == null) return null;
      if (typeof slot.priority !== "number") return null;
      return slot;
    } catch (err: any) {
      process.stderr.write(`[KitSlotLoader] factory error for "${name}": ${err?.message ?? err}\n`);
      return null;
    }
  }

  async load(ctx: AgentContext): Promise<Map<string, ContextSlot>> {
    const reg = await this.loadOnce(ctx);
    const out = new Map<string, ContextSlot>();
    for (const [k, v] of reg) {
      if (v !== null) out.set(k, v);
    }
    return out;
  }
}
