// @desc Ask the parent agent a question and block until a reply is received
import type { ToolDefinition, ToolOutput, Event } from "#src/core/types.js";

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

export default {
  name: "question",
  description:
    "Ask your parent agent a question and wait for a reply. " +
    "This is a BLOCKING call — the tool will not return until the parent replies. " +
    "Use when you encounter ambiguity or need clarification to proceed.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Your question in natural language",
      },
    },
    required: ["content"],
  },
  condition: (ctx) => typeof ctx.teamBoard.get(ctx.agentId, "subagent_type") === "string",
  async execute(args, ctx): Promise<ToolOutput> {
    const content = String(args.content ?? "").trim();
    if (!content) return '"content" is required';

    const parent = ctx.tree.getParent(ctx.agentId);
    if (!parent) return "No parent node found — question is only available for subagents";

    ctx.eventBus.emit({
      source: `agent:${ctx.agentId}`,
      type: "report",
      to: parent.id,
      payload: { reportType: "question", content },
      ts: Date.now(),
      priority: 0,
      handoff: "steer",
    });

    const agentId = ctx.agentId;
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for parent reply"));
      }, QUESTION_TIMEOUT_MS);

      const onAbort = () => {
        cleanup();
        reject(new Error("Request cancelled while waiting for parent reply"));
      };

      const unsub = ctx.eventBus.observe((ev: Event) => {
        if (
          ev.type === "subagent_reply" &&
          ev.to === agentId
        ) {
          cleanup();
          resolve(String((ev.payload as Record<string, unknown>).content ?? ""));
        }
      });

      function cleanup() {
        clearTimeout(timer);
        unsub();
        ctx.signal.removeEventListener("abort", onAbort);
      }

      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });

    return `Parent replied: ${reply}`;
  },
} satisfies ToolDefinition;
