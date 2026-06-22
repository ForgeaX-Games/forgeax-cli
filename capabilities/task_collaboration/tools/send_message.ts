// @desc Universal communication primitive: deliver to recipients (innerLoop), optionally append to a task's log.jsonl.

import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { taskExists, readTaskFile } from "../lib/task-dir.js";
import { appendTaskLog } from "../lib/task-log.js";

export default {
  name: "send_message",
  description:
    "Send a natural-language message to one or more agents. " +
    "All recipients are woken (innerLoop) on their next turn. " +
    "When scope.task_id is set, the message is appended to that task's log.jsonl. " +
    "Set scope.progress=true to also wake the task's issuer (if not already in `to`). " +
    "After sending, output a brief confirmation and end your turn — do not wait for replies.",
  guidance:
    "## When to use\n" +
    "This is your ONLY channel to communicate with other agents. " +
    "Your normal text output (assistant message) is only seen by the user — other agents cannot see it. " +
    "If you want another agent to receive information, you MUST call send_message.\n\n" +
    "**Reply to incoming messages**: when you receive a message from another agent, " +
    "use send_message(to=[sender_id]) to reply. Not replying = the sender never hears back.\n\n" +
    "**Report to parent / manager**: when you finish work, discover something important, " +
    "or need guidance, send_message to your parent agent.\n\n" +
    "**Coordinate with peers**: when you need information from a sibling agent " +
    "or want to share results, send_message to them directly.\n\n" +
    "## Parameters\n" +
    "to: array of agent IDs (single-recipient = 1-element array). " +
    "Recipients can be parent / children / siblings / any agent in the tree.\n" +
    "scope.task_id: anchor message to a task (logged + visible to task participants).\n" +
    "scope.progress=true: real-progress signal — also wakes the task's issuer.\n\n" +
    "## Common patterns\n" +
    "Replying to a message → send_message(to=[sender_id], content=your_reply).\n" +
    "Asking parent for help → send_message(to=[parent_id], content=your_question).\n" +
    "Reporting task progress → send_message(to=[issuer], scope={task_id, progress: true}, content=summary).",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Recipient agent ID(s). Pass a one-element array for a single recipient.",
      },
      content: {
        type: "string",
        description: "Message body in natural language.",
      },
      scope: {
        type: "object",
        description: "Optional task scope.",
        properties: {
          task_id: {
            type: "string",
            description: "Anchor message to this task; appended to tasks/{task_id}/log.jsonl.",
          },
          progress: {
            type: "boolean",
            description: "When true, the task's issuer also wakes (innerLoop) if not already in `to`.",
          },
        },
      },
    },
    required: ["to", "content"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const rawTo = args.to;
    const content = String(args.content ?? "").trim();
    if (!content) return "Error: 'content' is required";

    const recipients = Array.isArray(rawTo)
      ? (rawTo as unknown[]).map(x => String(x).trim()).filter(s => s.length > 0)
      : [String(rawTo ?? "").trim()].filter(s => s.length > 0);
    if (recipients.length === 0) return "Error: 'to' must be a non-empty agent ID or non-empty array";

    // Validate each recipient exists in the agent tree.
    const unknownIds: string[] = [];
    for (const id of recipients) {
      if (!ctx.tree.getNode(id)) unknownIds.push(id);
    }
    if (unknownIds.length > 0) {
      return `Error: unknown agent ID(s): [${unknownIds.join(", ")}]`;
    }

    const scope = (args.scope ?? {}) as { task_id?: string; progress?: boolean };
    const taskId = scope.task_id != null ? String(scope.task_id).trim() : undefined;
    const progress = scope.progress === true;

    // Resolve issuer if scope.task_id present and progress flag set.
    let issuerToWake: string | undefined;
    if (taskId) {
      if (!taskExists(ctx.pathManager, taskId)) {
        return `Error: scope.task_id '${taskId}' has no corresponding folder under shared-workspace/tasks/`;
      }
      if (progress) {
        try {
          const tf = readTaskFile(ctx.pathManager, taskId);
          if (tf.issuer && !recipients.includes(tf.issuer)) {
            issuerToWake = tf.issuer;
          }
        } catch { /* parse error → skip issuer wake */ }
      }
    }

    // Final fan-out set (deduplicated).
    const all = new Set<string>(recipients);
    if (issuerToWake) all.add(issuerToWake);

    // Fan-out: emit one event per target with innerLoop handoff.
    for (const target of all) {
      ctx.eventBus.emit({
        source: ctx.agentId,
        type: "message",
        to: target,
        payload: { content },
        ts: Date.now(),
        handoff: "innerLoop",
        priority: 0,
      }, ctx.agentId);
    }

    // Append to task log if scope.task_id present.
    if (taskId) {
      try {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "message",
          from: ctx.agentId,
          to: [...all],
          progress: progress || undefined,
          content,
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        return `Message sent to [${[...all].join(", ")}] but log append failed: ${msg}`;
      }
    }

    const preview = content.length > 50 ? content.slice(0, 50) + "…" : content;
    const taskHint = taskId ? ` (task=${taskId}${progress ? ", progress" : ""})` : "";
    return `Sent to [${[...all].join(", ")}]${taskHint}: ${preview}`;
  },
  serial: false,
} satisfies ToolDefinition;
