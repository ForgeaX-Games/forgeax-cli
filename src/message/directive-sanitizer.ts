// @desc Sanitize XML tags whose name contains 'system' / 'principle' in user/cross-agent inbound content
import type { ContentPart } from "../core/types.js";

/**
 * Reserved-keyword downgrade: tag names containing the substring `system` or
 * `principle` get rewritten as `<user-{name}>` in inbound user / cross-agent
 * message content. The two keywords are chosen because LLMs (especially
 * Anthropic models) acquire a strong training prior treating `<system>` /
 * `<...principle>` style tags as authoritative framework / alignment
 * directives. Other slot names (`framework-awareness`, `tool_guidance`, etc.)
 * carry no such prior — sanitizing them would be cosmetic theatre.
 *
 * Scope: untrusted inbound content only —
 *   - direct user input (`user_input` events)
 *   - cross-agent messages (`message` events)
 *
 * **Not applied to tool_result content.** Tool calls are agent-initiated,
 * and the wire format wraps tool output in a `tool_result` ContentBlock
 * (Anthropic) / `role:"tool"` message (OpenAI) / `functionResponse` (Gemini).
 * The structural boundary + LLM training prior already isolate tool output
 * from framework injection. Sanitizing tool_result would also break
 * legitimate use cases like `read_file` returning a changelog/experience
 * file that quotes `<system-reminder>` literally as documentation.
 *
 * Examples downgraded:   `<system-reminder>` `<core-principle>`
 *                        `<my-system-info>` `<principles>` `<system>`
 * Examples not touched:  `<framework-awareness>` `<tool_guidance>`
 *                        `<core-rule>` `<self-protection>`
 */
const KEYWORD_PATTERN = /<(\/?)([\w-]*(?:system|principle)[\w-]*)(\s|>|\/)/gi;

function sanitizeText(text: string): string {
  return text.replace(KEYWORD_PATTERN, "<$1user-$2$3");
}

/** Sanitize keyword-bearing XML tags in ContentPart[]. Used by message-ingress for inbound user/cross-agent events. */
export function sanitizeParts(parts: ContentPart[]): ContentPart[] {
  return parts.map((p) =>
    p.type === "text" ? { ...p, text: sanitizeText(p.text) } : p,
  );
}
