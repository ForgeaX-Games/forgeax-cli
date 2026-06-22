// @desc Todos slot — always shows current todo list regardless of plan state
import type { SlotFactory, ContextSlot } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const BOARD_KEY = "todo-list";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  cancelled: "✗",
};

function renderTodos(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return "";
  const done = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  const active = todos.length - done - cancelled;
  const lines = todos.map((t) => `  ${STATUS_ICON[t.status]} [${t.id}] ${t.content}`);
  return `## Current Todos (${done}/${active} completed)\n\n${lines.join("\n")}\n`;
}

const create: SlotFactory = (ctx): ContextSlot => {
  const { agentId, teamBoard } = ctx;

  return {
    name: "todos",
    priority: SlotPriority.DYNAMIC_CONTEXT,
    cacheHint: "dynamic",
    condition: () => {
      const todos = teamBoard.get(agentId, BOARD_KEY) as TodoItem[] | undefined;
      return Array.isArray(todos) && todos.length > 0;
    },
    content: () => {
      const todos = teamBoard.get(agentId, BOARD_KEY) as TodoItem[] | undefined;
      return renderTodos(todos ?? []);
    },
    version: 0,
  };
};

export default create;
