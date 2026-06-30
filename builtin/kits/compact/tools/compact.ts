import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";
import { compactCurrentSession } from "../../../../src/context-window/summary-compaction";

export default {
  name: "compact",
  description:
    "Compact the current session by summarizing older messages. " +
    "Reduces context window usage while preserving the most recent user-message-anchored " +
    "protection zone. Safe to invoke at any time including mid-turn — the compaction " +
    "split point lands on a user message boundary, never breaking thinking sequences " +
    "or tool_use / tool_result pairs.",
  input_schema: {
    type: "object",
    properties: {
      instructions: {
        type: "string",
        description: "Custom instructions for the summarizer, e.g. 'Focus on game state and bot actions'",
      },
    },
  },
  condition(ctx) {
    return !!ctx.ledger && !!ctx.resolveModels;
  },
  async execute(args, ctx): Promise<ToolOutput> {
    if (!ctx.ledger) return "Ledger unavailable.";
    if (!ctx.resolveModels) return "Model config unavailable.";

    const result = await compactCurrentSession({
      agentId: ctx.agentPath,
      ledger: ctx.ledger,
      eventBus: ctx.eventBus,
      resolveModels: ctx.resolveModels,
      signal: ctx.signal,
      instructions: args.instructions as string | undefined,
    });

    if (result.ok === false) {
      console.warn(`compact skipped: ${result.reason}`);
      return result.reason;
    }

    console.log(
      `compact (partial) done | msgs: ${result.originalMessageCount} → ${result.newMessageCount}` +
      (result.tokensBefore ? ` | tokens before: ${result.tokensBefore}` : "") +
      (result.summarizeUsage
        ? ` | summary tokens: ${result.summarizeUsage.inputTokens + result.summarizeUsage.outputTokens}`
        : ""),
    );

    return `Partial compaction complete. Context window trimmed from ${result.originalMessageCount} to ~${result.newMessageCount} messages.`;
  },
  compactResult() {
    return "[compact: done]";
  },
  formatDisplay(_args, result) {
    return typeof result === "string" ? result : "compacted";
  },
  serial: true,
} satisfies ToolDefinition;
