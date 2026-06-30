/** history-pipeline —— StoredEvent[] → LLMMessage[]。
 *
 *  与 ref 1:1：拆 payload.llmMessage（可能是单条或数组），逐条 normalizeContent。
 *  把字符串 content 升格成 ContentPart[]，让下游 sanitizeMedia / microCompact /
 *  modalityFilter 都拿到统一形态。
 *
 *  hook:systemPrompt events → role:"system" carrier (dynamic-reminder)。 */

import type { LLMMessage } from "../llm/types";
import type { ContentPart } from "../core/types";
import type { StoredEvent } from "../ledger/types";
import { normalizeContent } from "../message/modality";
import { materializeSystemPromptEvent } from "./dynamic-reminder";

export function eventsToMessages(events: readonly StoredEvent[]): LLMMessage[] {
  const msgs: LLMMessage[] = [];
  for (const rec of events) {
    if (rec.type === "hook:systemPrompt") {
      const reminder = materializeSystemPromptEvent(rec);
      if (reminder) msgs.push(reminder);
      continue;
    }

    const llmMsg = rec.payload?.llmMessage as LLMMessage | LLMMessage[] | undefined;
    if (!llmMsg) continue;
    const arr = Array.isArray(llmMsg) ? llmMsg : [llmMsg];
    for (const rawMsg of arr) {
      const content = typeof rawMsg.content === "string"
        ? normalizeContent(rawMsg.content)
        : (rawMsg.content as ContentPart[]);
      msgs.push({ ...rawMsg, content });
    }
  }
  return msgs;
}
