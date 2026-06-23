// Stub: message utilities (partial, replaces claude-code utils/messages.ts)

/**
 * Strips <prompt> and </prompt> XML tags from text.
 * In claude-code these are used to delimit prompt content; we pass through unchanged.
 */
export function stripPromptXMLTags(text: string): string {
  return text.replace(/<\/?prompt>/g, '')
}
