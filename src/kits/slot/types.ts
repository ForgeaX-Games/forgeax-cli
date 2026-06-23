/** ContextSlot types + SlotPriority constants.
 *  Ported from agenteam-os-ref/src/capability/slot/types.ts
 *  (forgeax 命名统一在 kits/ 下，slot 名称沿用 ref)。 */

import type { AgentContext } from "../../core/types";

/**
 * Slot priority constants — each cacheHint section has its own 0..99 priority
 * space. Lower priority = appears earlier within its section.
 */
export const SlotPriority = {
  // ─── Stable section (cacheHint: "stable") — 0..99 ────────────
  STATIC_CORE:                  0,
  STATIC_FRAMEWORK:            10,
  STATIC_PRINCIPLE:            20,
  STATIC_MEMORY_RECOGNITION:   30,
  STATIC_ENVIRONMENT:          40,
  STATIC_DEFAULT:              50,

  // ─── Dynamic section (cacheHint: "dynamic") — independent 0..99 ──
  DYNAMIC_TOOL_GUIDANCE:        0,
  DYNAMIC_SKILLS:              10,
  DYNAMIC_CONTEXT:             30,
  DYNAMIC_DEFAULT:             50,
  DYNAMIC_SUBAGENTS:           90,
} as const;

export interface ContextSlot {
  name: string;
  description: string;
  /** If present and returns false, slot is omitted from this turn's prompt. */
  condition?: (ctx: AgentContext, self?: ContextSlot) => boolean;
  priority: number;
  content: string | (() => string);
  version: number;
  /**
   * "stable"  — stable system prompt prefix (cache-friendly).
   * "dynamic" — changes per turn; lives after the cache marker.
   * Defaults to "dynamic" (fail-safe for prompt cache).
   */
  cacheHint?: "stable" | "dynamic";
}

export type SlotContext = AgentContext;
