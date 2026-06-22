/** @desc Slot assembly pipeline — resolve, sort, render, return SystemBlock[].
 *
 * Design notes:
 *   - `content()` is strictly sync (`() => string`). Slots needing IO use the
 *     fs-bridge sync API (`getSandboxFs().readTextSync()` etc.) directly inside
 *     `content()` — closure caching is at the slot author's discretion.
 *   - Each slot's content() runs inside try/catch, so a single broken slot
 *     degrades to empty output + a warning — the rest of the prompt still assembles.
 *     This used to be the #1 source of "one capability breaks → whole agent dies" incidents.
 *   - Output: `assembleSystemBlocks` returns a flat `SystemBlock[]` already sorted
 *     by (cacheHint section, priority asc). Each block carries its own `cacheHint`
 *     field — providers partition on it themselves to decide wire format (e.g.
 *     stable → system field, dynamic → embedded in messages tail).
 *   - cacheHint resolution: explicit `slot.cacheHint` is the single source of truth.
 *     When omitted, defaults to "dynamic" (fail-safe — never accidentally pollute the
 *     stable prefix). Priority is no longer used for cacheHint inference.
 *
 * History: an earlier version had an async `preload` stage that ran before
 * `content()` to populate closure caches via `ctx.fs.readText`. That phase was
 * removed once fs-bridge gained sync APIs (`getSandboxFs().readTextSync()` etc.)
 * — all slot authors moved their IO directly into `content()` and the preload
 * stage saw zero use in `capabilities/`. See changelog 2026-05-12.
 */
import type { ContextSlot } from "./types.js";
import type { AgentContext } from "../../core/types.js";
import type { SystemBlock } from "../../llm/types.js";
import { withModelFeedback } from "../../core/logger.js";

interface ResolvedSlot {
  slot: ContextSlot;
  text: string;
}

function resolveCacheHint(slot: ContextSlot): "stable" | "dynamic" {
  // Explicit declaration is authoritative; default is "dynamic" (fail-safe).
  return slot.cacheHint ?? "dynamic";
}

function resolveContent(slot: ContextSlot): string {
  try {
    const raw = typeof slot.content === "function" ? slot.content() : slot.content;
    if (typeof raw !== "string") {
      withModelFeedback(() =>
        console.error(
          `[prompt-pipeline] slot "${slot.name}" content() returned ${typeof raw} instead of string — skipped`,
        ),
      );
      return "";
    }
    return raw;
  } catch (err) {
    // Isolation barrier: one broken slot must not crash the whole prompt assembly.
    withModelFeedback(() =>
      console.error(`[prompt-pipeline] slot "${slot.name}" content() threw — skipped:`, err),
    );
    return "";
  }
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([\w.]+)\}/g, (_, key) => vars[key] ?? "");
}

// ─── Stage 1: Resolve — evaluate lazy content for already-active slots ───
// Condition was applied once at the top of assembleSystemBlocks, so here we
// only need to map through; no second filter pass.

function resolveSlots(slots: ContextSlot[]): ResolvedSlot[] {
  return slots.map((slot) => {
    const text = resolveContent(slot);
    return { slot, text };
  });
}

// ─── Stage 2: Sort — by section first, priority asc within section ───
// Each cacheHint section (stable / dynamic) has its own independent 0..99
// priority space. Sort places stable section first, then dynamic; within
// each section blocks appear in priority asc order. Downstream providers
// can partition this flat array on `cacheHint` to route the two sections
// to different prompt locations (e.g. system vs messages tail).

function sortSlots(resolved: ResolvedSlot[]): ResolvedSlot[] {
  return resolved.slice().sort((a, b) => {
    const ka = resolveCacheHint(a.slot);
    const kb = resolveCacheHint(b.slot);
    if (ka !== kb) return ka === "stable" ? -1 : 1;
    return a.slot.priority - b.slot.priority;
  });
}

// ─── Stage 3: Render — template variable substitution ───

function renderSlots(
  resolved: ResolvedSlot[],
  vars: Record<string, string>,
): ResolvedSlot[] {
  return resolved.map((r) => ({
    ...r,
    text: renderTemplate(r.text, vars),
  }));
}

// ─── Public API ───

function wrapXml(name: string, text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(`<${name}>`) || trimmed.startsWith(`<${name} `)) {
    return text;
  }
  return `<${name}>\n${text}\n</${name}>`;
}

/**
 * Async signature is preserved for backward compatibility with all call sites
 * that `await` the result. Internally the work is purely synchronous now.
 */
export async function assembleSystemBlocks(
  slots: ContextSlot[],
  ctx: AgentContext,
  vars: Record<string, string> = {},
): Promise<SystemBlock[]> {
  // Single condition pass — everything downstream operates on `active` only.
  const active = slots.filter((slot) => !slot.condition || slot.condition(ctx, slot));

  let resolved = resolveSlots(active);
  resolved = sortSlots(resolved); // (cacheHint section, priority asc) ordering
  resolved = renderSlots(resolved, vars);

  // Returns flat array — each block carries its own cacheHint so providers can
  // partition it themselves (no need to pre-split into two arrays here).
  return resolved
    .filter((r) => r.text)
    .map<SystemBlock>((r) => ({
      name: r.slot.name,
      text: wrapXml(r.slot.name, r.text),
      cacheHint: resolveCacheHint(r.slot),
      priority: r.slot.priority,
    }));
}

export function blocksToText(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}
