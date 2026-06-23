// @desc Provider-side helpers — SystemBlock partition + dynamic-reminder embedding
import type { ContentPart } from "../core/types.js";
import type { LLMMessage, SystemBlock } from "./types.js";
import { blocksToText } from "../capability/slot/prompt-pipeline.js";

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
 * Heartbeat cadence — how many tool_results have to accumulate inside a
 * single tool-loop before we override the mid-loop skip and force one
 * reminder injection. Picked from production telemetry over 996 historical
 * tool loops (framework_evolver admin, 04-17 → 05-13):
 *
 *   - p50 loop length = 4 turns,  p75 = 9,  p90 = 17,  p95 = 23,  max = 72
 *   - 89% of loops complete in ≤ 8 turns → no heartbeat ever fires for them,
 *     keeping the "no narration interruption" guarantee that motivated the
 *     mid-loop skip in the first place.
 *   - The remaining ~11% of long-running loops get reminded every 8th tool
 *     round (~3-5 minutes of wall time on average). That's frequent enough
 *     to keep clock / todo / framework-rules in the model's working set
 *     without re-creating the "model keeps re-acknowledging the reminder"
 *     repetition pathology we measured pre-skip (Jaccard repetition rate
 *     went from 9.8% → 19.5% across the slot v1 → v2 transition).
 *
 * Operationally this adds <8% extra reminder injections vs the "always skip"
 * baseline (456 / 6046 mid-loop tool turns over 5 weeks of admin traffic).
 */
const HEARTBEAT_EVERY_N_TOOL_RESULTS = 8;

/**
 * Count of tool_result messages at the conversation tail (i.e. depth into
 * the ongoing tool loop). Walks backwards from the last message and:
 *   - counts every `role: "tool"` message (Anthropic → user/tool_result,
 *     OpenAI → role "tool", Gemini → functionResponse);
 *   - silently skips intervening `role: "assistant"` messages that still
 *     have pending toolCalls — they're the model's tool_use side of the
 *     same round, not a fresh assistant turn;
 *   - stops at the first `role: "user"` or "closed" assistant (no toolCalls)
 *     because that's where the loop began.
 *
 * Returns 0 when the tail is itself a fresh assistant tool_use that hasn't
 * been answered yet (depth measures *completed* tool rounds).
 */
function midLoopDepth(messages: LLMMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") { n++; continue; }
    if (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0) continue;
    break;
  }
  return n;
}

/**
 * Append dynamic blocks as a fresh trailing `role: "user"` message holding one
 * `<system-reminder>...</system-reminder>` text block. Two suppression rules
 * apply, in order:
 *
 *   1. **Mid-tool-loop skip** — when the tail is a `role: "tool"` result or
 *      an assistant message with pending `toolCalls`, the assistant turn
 *      started in a previous request hasn't finished yet. Wedging a fresh
 *      user-text into a live tool loop:
 *        a. Severs reasoning continuity. Anthropic / GPT-5 / Gemini reasoning
 *           models treat `tool_result` as the same assistant turn (interleaved
 *           thinking continues across rounds). A surprise user message biases
 *           the model toward `end_turn` (a documented Anthropic failure mode
 *           for "text after tool_result").
 *        b. Trains the model to RE-acknowledge the reminder every round —
 *           we measured adjacent spoken-tool-turn Jaccard repetition climb
 *           from ~10% (pre-slot) to ~19% with "highly repetitive" pairs
 *           (≥50% bigram overlap) jumping from 0.1% to 7.2%.
 *
 *   2. **Heartbeat exception** — long-running tool loops still need
 *      occasional clock / todo / state refresh, otherwise dynamic content
 *      goes stale for the entire duration of the loop. Once `midLoopDepth`
 *      crosses a multiple of {@link HEARTBEAT_EVERY_N_TOOL_RESULTS}, we
 *      inject one reminder, then resume skipping until the next multiple.
 *      With N=8 this fires only inside the ~11% of loops that exceed 8
 *      tool rounds.
 *
 * For tails that are user messages or "closed" assistant messages (no
 * pending toolCalls — i.e. an explicit conversational boundary), the
 * reminder is injected unconditionally. The trailing `role:"user"` shape
 * (rather than appending into an existing user content array) is what keeps
 * cache prefix stable across turns: dynamic bytes always live AFTER the
 * Anthropic marker-B / OpenAI/Gemini implicit prefix cache window, so prior
 * history bytes never shift.
 *
 * Transient — input is not mutated, only the on-wire form carries the reminder.
 */
export function embedDynamicInLastUserContent(
  messages: LLMMessage[],
  dynamicBlocks: SystemBlock[],
): LLMMessage[] {
  if (dynamicBlocks.length === 0) return messages;

  const tail = messages[messages.length - 1];
  const tailIsTool = tail?.role === "tool";
  const tailIsAsstWithCalls =
    tail?.role === "assistant" && (tail.toolCalls?.length ?? 0) > 0;

  if (tailIsTool || tailIsAsstWithCalls) {
    const depth = midLoopDepth(messages);
    // Heartbeat fires when depth is a positive multiple of N.
    // depth === 0 (tail is a fresh assistant tool_use) always skips.
    if (depth === 0 || depth % HEARTBEAT_EVERY_N_TOOL_RESULTS !== 0) {
      return messages;
    }
  }

  const reminderText = `<system-reminder>\n${blocksToText(dynamicBlocks)}\n</system-reminder>`;
  const reminderContent: ContentPart[] = [{ type: "text", text: reminderText }];
  return [...messages, { role: "user", content: reminderContent }];
}
