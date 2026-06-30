// @desc Provider-side helpers — SystemBlock partition + dynamic-reminder folding
import type { ContentPart } from "../core/types.js";
import type { LLMMessage, SystemBlock } from "./types.js";

export function blocksToText(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

/**
 * Split SystemBlock[] by cacheHint. Each adapter routes its own way:
 *   - Anthropic: stable → `system` (marker A); dynamic → trailing user msg
 *   - OpenAI Responses: both → `instructions` (cache keys on `input` only)
 *   - OpenAI-compat / DeepSeek: stable → `messages[0]`; dynamic → trailing user msg
 *   - Gemini: stable → `systemInstruction`; dynamic → trailing user msg
 */
export function partitionSystemBlocks(blocks: SystemBlock[]): {
  stable: SystemBlock[];
  dynamic: SystemBlock[];
} {
  const stable: SystemBlock[] = [];
  const dynamic: SystemBlock[] = [];
  for (const b of blocks) {
    if ((b.cacheHint ?? "dynamic") === "stable") stable.push(b);
    else dynamic.push(b);
  }
  return { stable, dynamic };
}

/**
 * Fold `role:"system"` carrier messages (dynamic reminders) into adjacent
 * `role:"user"` or `role:"tool"` messages as `<system-reminder>` text blocks.
 *
 * LLM APIs don't support `role:"system"` in the messages array (only as a
 * top-level system prompt). The context-window materializes dynamic-delta
 * events as `role:"system"` carriers so they're cache-prefix stable; here we
 * "smoosh" each carrier into its nearest non-assistant neighbor before sending
 * on-wire.
 *
 * Strategy: fold into the PRECEDING user/tool message. If none (carrier is
 * first), fold into the NEXT user/tool. If truly no neighbor at all (edge
 * case: all-system history), drop the carrier silently.
 */
export function foldDynamicReminders(messages: LLMMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  const pendingFolds: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      const text = (msg.content ?? [])
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (!text) continue;
      const reminderText = `<system-reminder>\n${text}\n</system-reminder>`;

      // Try to fold into preceding message in `out`
      const prev = out[out.length - 1];
      if (prev && (prev.role === "user" || prev.role === "tool")) {
        prev.content = [
          ...prev.content,
          { type: "text", text: reminderText },
        ];
      } else {
        // Queue for next user/tool message
        pendingFolds.push(reminderText);
      }
      continue;
    }

    // Regular message — flush any pending folds into it if it's user/tool
    if (pendingFolds.length > 0 && (msg.role === "user" || msg.role === "tool")) {
      const clone: LLMMessage = {
        ...msg,
        content: [
          ...pendingFolds.map((text) => ({ type: "text" as const, text })),
          ...msg.content,
        ],
      };
      out.push(clone);
      pendingFolds.length = 0;
    } else {
      out.push(msg);
    }
  }

  // If any pending folds remain (no suitable host found), append them to the
  // last message in out regardless of role — better than dropping.
  if (pendingFolds.length > 0 && out.length > 0) {
    const last = out[out.length - 1];
    last.content = [
      ...last.content,
      ...pendingFolds.map((text) => ({ type: "text" as const, text })),
    ];
  }

  return out;
}
