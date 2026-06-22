// @desc Convert stored events into LLM message history
import type { LLMMessage } from "../llm/types.js";
import type { ContentPart } from "../core/types.js";
import type { StoredEvent } from "./system-snapshot.js";
import { normalizeContent } from "../message/modality.js";

/**
 * Convert StoredEvent[] → LLMMessage[].
 * Extracts `payload.llmMessage` from each event.
 */
export function eventsToMessages(events: readonly StoredEvent[]): LLMMessage[] {
  const msgs: LLMMessage[] = [];

  for (const rec of events) {
    const llmMsg = rec.payload?.llmMessage;
    if (!llmMsg) continue;

    const arr = Array.isArray(llmMsg) ? llmMsg as LLMMessage[] : [llmMsg as LLMMessage];
    for (const rawMsg of arr) {
      const content = typeof rawMsg.content === "string"
        ? normalizeContent(rawMsg.content)
        : rawMsg.content as ContentPart[];
      const msg: LLMMessage = { ...rawMsg, content };
      msgs.push(msg);
    }
  }
  return msgs;
}
