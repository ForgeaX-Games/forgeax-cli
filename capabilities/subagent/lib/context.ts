import type { AgentContext } from "#src/core/types.js";
import type { LLMMessage } from "#src/llm/types.js";
import { stripThinkingBlocks } from "#src/llm/thinking.js";
import { ContextWindow } from "#src/context-window/context-window.js";
import type { ContextMode } from "./types.js";

export async function buildInitialPrompt(
  ctx: AgentContext,
  task: string,
  contextMode: ContextMode,
): Promise<string> {
  if (contextMode === "none" || !ctx.ledger) return task;

  const cw = new ContextWindow(ctx.agentId, ctx.ledger);
  // No microCompact tuning needed — `renderParentContext` filters out all tool
  // messages anyway (line below: `filter((msg) => msg.role !== "tool")`),
  // so any `keepRecentTools` value would be a no-op here.
  const history = await cw.buildPrompt();
  const contextText = renderParentContext(history, contextMode);
  if (!contextText) return task;

  return `${task}\n\nParent context for reference:\n${contextText}`;
}

export function renderParentContext(history: LLMMessage[], contextMode: ContextMode): string {
  const maxMessages = contextMode === "summary" ? 8 : 20;
  const maxChars = contextMode === "summary" ? 6000 : 16000;

  const relevant = history
    .filter((msg) => msg.role !== "tool")
    .slice(-maxMessages)
    .map((msg) => `[${msg.role}] ${serializeContent(msg.content)}`)
    .filter((line) => line.trim().length > 0);

  if (relevant.length === 0) return "";

  let text = relevant.join("\n\n");
  if (text.length > maxChars) {
    text = `[truncated]\n${text.slice(text.length - maxChars)}`;
  }
  return text;
}

export function serializeContent(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return stripThinkingBlocks(content).replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map(p => p.text)
      .join("\n")
      .trim() || JSON.stringify(content);
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "[unserializable content]";
  }
}
