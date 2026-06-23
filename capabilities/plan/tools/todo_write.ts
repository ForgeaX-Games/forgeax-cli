// @desc Create or update a structured todo list for tracking multi-step tasks
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TODO_BOARD_KEY, type TodoItem } from "./create_plan.js";

const STATUS_ICON: Record<TodoItem["status"], string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  cancelled: "✗",
};

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "";
  const done = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  const active = todos.length - done - cancelled;
  const lines = todos.map((t) => `  ${STATUS_ICON[t.status]} [${t.id}] ${t.content}`);
  return `## Todos (${done}/${active} completed)\n\n${lines.join("\n")}\n`;
}

export default {
  name: "todo_write",
  description:
    "Create or update a structured todo list for tracking multi-step tasks.\n\n" +
    "Use `merge: true` to incrementally update by id. " +
    "Use `merge: false` to replace the entire list. " +
    "Use `clear: true` to remove all todos.\n\n" +
    "Status values: pending, in_progress, completed, cancelled. " +
    "Keep exactly one task in_progress at a time.",
  guidance: "**todo_write**: Use for 3+ step tasks. Keep exactly one in_progress; mark complete immediately when done.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique todo identifier" },
            content: { type: "string", description: "Todo description (omit when only updating status)" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
          },
          required: ["id"],
        },
        description: "Todo items to create or update (ignored if clear=true)",
      },
      merge: {
        type: "boolean",
        description: "If true, merge by id. If false, replace entire list.",
      },
      clear: {
        type: "boolean",
        description: "If true, remove all todos.",
      },
    },
    required: [],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const board = ctx.teamBoard;
    const agentId = ctx.agentId;
    const slotApi = ctx.slots;
    if (!slotApi) return "Error: todo_write requires slot registry access.";

    if (args.clear === true) {
      board.remove(agentId, TODO_BOARD_KEY);
      if (slotApi.get("todos") !== undefined) slotApi.release("todos");
      return "Cleared all todos.";
    }

    const incoming = args.todos as Partial<TodoItem>[] | undefined;
    const merge = args.merge as boolean;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return "Error: todos must be a non-empty array (or use clear=true to remove all).";
    }

    let current = (board.get(agentId, TODO_BOARD_KEY) as TodoItem[]) ?? [];

    if (merge) {
      for (const item of incoming) {
        if (!item.id) return "Error: each todo must have an 'id' field.";
        const idx = current.findIndex((t) => t.id === item.id);
        if (idx >= 0) {
          if (item.content !== undefined) current[idx].content = item.content;
          if (item.status !== undefined) current[idx].status = item.status;
        } else {
          if (!item.content || !item.status) return `Error: new todo '${item.id}' requires both 'content' and 'status'.`;
          current.push({ id: item.id, content: item.content, status: item.status });
        }
      }
    } else {
      current = incoming.map((t) => {
        if (!t.id || !t.content || !t.status) throw new Error(`Todo requires id, content, and status. Got: ${JSON.stringify(t)}`);
        return { id: t.id, content: t.content, status: t.status };
      });
    }

    board.set(agentId, TODO_BOARD_KEY, current, { persist: true });

    const rendered = renderTodos(current);
    const existing = slotApi.get("todos");
    if (rendered) {
      if (existing !== undefined) slotApi.update("todos", rendered);
      else slotApi.register("todos", rendered);
    } else if (existing !== undefined) {
      slotApi.release("todos");
    }

    const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const t of current) counts[t.status]++;
    const summary = `Updated ${current.length} todo(s): ${counts.completed} done, ${counts.in_progress} active, ${counts.pending} pending.`;
    const lines = current.map((t) => `  ${STATUS_ICON[t.status]} [${t.id}] ${t.content}`);
    return `${summary}\n[todos] ${counts.completed}/${current.length}\n${lines.join("\n")}`;
  },
  formatDisplay(_args, result) {
    if (typeof result !== "string") return "";
    const idx = result.indexOf("\n[todos]");
    return idx >= 0 ? result.slice(idx + 1) : result;
  },
} satisfies ToolDefinition;
