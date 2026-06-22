/** @desc Slot types — ContextSlot, SlotFactory, SlotPriority constants */
import type { AgentContext, CapabilityBase } from '../../core/types.js';

/**
 * Slot priority constants — each cacheHint section has its own 0..99 priority
 * space. `assembleSystemBlocks` returns a flat `SystemBlock[]` already sorted
 * by (cacheHint section, priority asc) — each block carries its own
 * `cacheHint` field so downstream providers partition the flat array
 * themselves. Priority numbers don't compete across sections: a stable slot
 * with priority 90 is the last stable block; a dynamic slot with priority 0
 * is the first dynamic block. Lower priority = appears earlier within its
 * section.
 */
export const SlotPriority = {
  // ─── Stable section (cacheHint: "stable") — 0..99 ────────────
  /** agents/{id}/SOUL.md — agent identity, almost never changes */
  STATIC_CORE:         0,
  /** Reserved for static framework-level slots */
  STATIC_FRAMEWORK:   10,
  /** agents/{id}/PRINCIPLE.md — core-principle behavioral constraints */
  STATIC_PRINCIPLE:   20,
  /** memory-recognition.md — memory system cognitive map */
  STATIC_MEMORY_RECOGNITION: 30,
  /** environment (docker.md / direct.md) — runtime environment context */
  STATIC_ENVIRONMENT: 40,
  /** Anchor for external/test stable slots */
  STATIC_DEFAULT:     50,

  // ─── Dynamic section (cacheHint: "dynamic") — independent 0..99 ──
  /** tool usage guidance — changes when tools are loaded/unloaded */
  DYNAMIC_TOOL_GUIDANCE: 0,
  /** skills index — changes when skill files are added/removed */
  DYNAMIC_SKILLS:    10,
  /** context-file, todos, etc. — changes every turn */
  DYNAMIC_CONTEXT:   30,
  /** Anchor for external/test dynamic slots */
  DYNAMIC_DEFAULT:   50,
  /** subagents — end-of-prompt dynamic content */
  DYNAMIC_SUBAGENTS: 90,
} as const;

export interface ContextSlot extends CapabilityBase {
  priority: number;
  content: string | (() => string);
  version: number;
  /**
   * Cache hint — explicit declaration of which prompt section the slot belongs to:
   *   "stable"  — stable system prompt prefix (cache-friendly)
   *   "dynamic" — changes per turn; lives after the cache marker
   *
   * Defaults to "dynamic" when omitted — fail-safe for cache: an unmarked
   * slot is treated as potentially-changing, so it never accidentally
   * pollutes the stable prefix and busts the prompt cache.
   *
   * Priority is purely for sort ordering within the slot's cacheHint section.
   * Each section (stable / dynamic) has its own independent 0..99 priority
   * space — a stable slot with priority 90 doesn't compete with a dynamic
   * slot with priority 0; they live in separate sections.
   */
  cacheHint?: "stable" | "dynamic";
}

export type SlotFactory = (ctx: SlotContext) => ContextSlot;

export type SlotContext = AgentContext;

export interface ThoughtType {
  name: string;
  readOnly: boolean;
  defaultModel?: string;
  maxIterations: number;
}

export interface ThoughtConfig {
  readOnly: boolean;
  tools: string[];
  model?: string;
  maxIterations: number;
}
