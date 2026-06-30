/** Slot assembly pipeline — resolve, sort, render, return SystemBlock[].
 *  Ported from agenteam-os-ref/src/capability/slot/prompt-pipeline.ts
 *  (forgeax 命名统一在 kits/ 下，slot 名称沿用 ref)。
 *
 *  Design:
 *  - condition filter runs once at the top (single pass).
 *  - content() runs inside try/catch — one broken slot degrades to empty,
 *    rest of the prompt still assembles.
 *  - Sort: (cacheHint section, priority asc). stable before dynamic.
 *  - Template: ${key} substitution via vars map.
 *  - Each SystemBlock carries its own cacheHint so providers can partition
 *    the flat array themselves.
 */

import type { AgentContext } from "../../core/types";
import type { SystemBlock } from "../../llm/types";
import type { ContextSlot } from "./types";
import { withModelFeedback } from "../../core/logger";

interface ResolvedSlot {
  slot: ContextSlot;
  text: string;
}

function resolveCacheHint(slot: ContextSlot): "stable" | "dynamic" {
  return slot.cacheHint ?? "dynamic";
}

function resolveContent(slot: ContextSlot): string {
  try {
    const raw = typeof slot.content === "function" ? slot.content() : slot.content;
    if (typeof raw !== "string") {
      withModelFeedback(() =>
        console.error(`[prompt-pipeline] slot "${slot.name}" content() returned ${typeof raw} — skipped`),
      );
      return "";
    }
    return raw;
  } catch (err) {
    withModelFeedback(() =>
      console.error(`[prompt-pipeline] slot "${slot.name}" content() threw — skipped:`, err),
    );
    return "";
  }
}

function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([\w.]+)\}/g, (_, key) => vars[key] ?? "");
}

function sortSlots(resolved: ResolvedSlot[]): ResolvedSlot[] {
  return resolved.slice().sort((a, b) => {
    const ka = resolveCacheHint(a.slot);
    const kb = resolveCacheHint(b.slot);
    if (ka !== kb) return ka === "stable" ? -1 : 1;
    return a.slot.priority - b.slot.priority;
  });
}

function wrapXml(name: string, text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(`<${name}>`) || trimmed.startsWith(`<${name} `)) {
    return text;
  }
  return `<${name}>\n${text}\n</${name}>`;
}

/**
 * Assemble SystemBlock[] from slots. Async signature preserved for call-site
 * compatibility; work is synchronous internally.
 */
export async function assembleSystemBlocks(
  slots: ContextSlot[],
  ctx: AgentContext,
  vars: Record<string, string> = {},
): Promise<SystemBlock[]> {
  const active = slots.filter((slot) => !slot.condition || slot.condition(ctx, slot));

  let resolved: ResolvedSlot[] = active.map((slot) => ({
    slot,
    text: resolveContent(slot),
  }));
  resolved = sortSlots(resolved);
  resolved = resolved.map((r) => ({ ...r, text: renderTemplate(r.text, vars) }));

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
