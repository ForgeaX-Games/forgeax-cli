import type { LLMMessage, SystemBlock } from "../llm/types";
import type { StoredEvent } from "../ledger/types";

function tombstoneBlock(name: string): SystemBlock {
  return {
    name,
    text: `<${name}>\nThis context block has been retracted and no longer applies — disregard any earlier <${name}> content.\n</${name}>`,
    cacheHint: "dynamic",
    priority: 999,
  };
}

export function renderDynamicReminder(
  changed: SystemBlock[],
  removed: readonly string[] = [],
): LLMMessage | null {
  const dynamic = changed.filter((b) => (b.cacheHint ?? "dynamic") !== "stable");
  const tombstones = removed.map(tombstoneBlock);
  const blocks = [...dynamic, ...tombstones].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  if (blocks.length === 0) return null;
  const text = blocks.map((b) => b.text).join("\n\n");
  return {
    role: "system",
    content: [{ type: "text", text }],
    systemBlocks: blocks,
  };
}

export function materializeSystemPromptEvent(rec: StoredEvent): LLMMessage | null {
  const changed = rec.payload?.changed;
  const removed = rec.payload?.removed;
  if (!Array.isArray(changed) && !Array.isArray(removed)) return null;
  return renderDynamicReminder(
    Array.isArray(changed) ? (changed as SystemBlock[]) : [],
    Array.isArray(removed) ? (removed as string[]) : [],
  );
}
