/**
 * Browser-compatible merge-tool-result — ported from ink-renderer.
 */
import type { RendererMessage, ToolCallMessage, ToolResultMessage } from "./types.js";

export function mergeToolResult(
  messages: RendererMessage[],
  result: ToolResultMessage,
): { index: number; merged: RendererMessage } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "tool_call" && (m as ToolCallMessage).id === result.callId) {
      const call = m as ToolCallMessage;
      const isError = result.isError
        || result.content?.startsWith("Error")
        || result.content?.startsWith("error");
      const merged: RendererMessage = {
        ...call,
        status: isError ? "error" : "done",
        resultDisplay: result.visualDisplay,
        resultContent: result.content,
        durationMs: result.durationMs,
      };
      return { index: i, merged };
    }
  }
  return null;
}
