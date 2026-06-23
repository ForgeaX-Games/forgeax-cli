// @desc Reply to a subagent's question
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

export default {
  name: "subagent_reply",
  description:
    "Reply to a subagent that asked you a question. " +
    "Use this when a foreground subagent returns status=question.",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "The subagent ID to reply to",
      },
      content: {
        type: "string",
        description: "Your reply in natural language",
      },
    },
    required: ["to", "content"],
  },
  condition: (ctx) => {
    return ctx.tree.getChildren(ctx.agentId).some(child =>
      typeof ctx.teamBoard.get(child.id, "subagent_type") === "string"
    );
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const to = String(args.to ?? "").trim();
    const content = String(args.content ?? "").trim();
    if (!to || !content) return '"to" and "content" are required';

    const subagents = ctx.tree.getChildren(ctx.agentId).filter(child =>
      typeof ctx.teamBoard.get(child.id, "subagent_type") === "string"
    );
    if (!subagents.some(n => n.id === to)) {
      const ids = subagents.map(n => n.id);
      return `'${to}' is not an active child subagent. Available: [${ids.join(", ")}]`;
    }

    ctx.eventBus.emit({
      source: `agent:${ctx.agentId}`,
      type: "subagent_reply",
      to,
      payload: { content },
      ts: Date.now(),
      priority: 0,
      handoff: "steer",
    });

    return `Reply sent to '${to}'`;
  },
  serial: false,
} satisfies ToolDefinition;
