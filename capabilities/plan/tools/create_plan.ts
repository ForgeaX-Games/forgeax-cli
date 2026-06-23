// @desc Persist a plan file (content + todos) — only available in plan_mode
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { findPendingPlans, planFilePath } from "../lib/plan-files.js";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export const TODO_BOARD_KEY = "todo-list";

export function sanitizeName(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || "current-plan";
}

function normalizeTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const todos: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const content = String(row.content ?? "").trim();
    if (!id || !content) return null;
    todos.push({ id, content, status: "pending" });
  }
  return todos;
}

function renderPlanMarkdown(name: string, content: string, todos: TodoItem[]): string {
  const lines: string[] = [];
  lines.push(`# ${name}`, "", content, "", "## Todos", "");
  for (const t of todos) {
    lines.push(`- [ ] **${t.id}**: ${t.content}`);
  }
  lines.push("");
  return lines.join("\n");
}

export default {
  name: "create_plan",
  description:
    "Create or update a plan: write the body text describing your approach, followed by a todo list. Only available in plan_mode.",
  guidance:
    "**create_plan**: Write the plan body (analysis, approach, key decisions) + a todo list. " +
    "After creating, use `review_plan` to assess, then `execute_plan` to begin.",
  condition(ctx) {
    return ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.STATUS) === "plan_mode";
  },
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Plan name for file persistence. Defaults to current-plan.",
      },
      content: {
        type: "string",
        description: "Plan body text in markdown: context, analysis, approach, key decisions, risks.",
      },
      todos: {
        type: "array",
        description: "Actionable todo list. Each item is a single executable unit.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable short id (e.g. t1, t2)." },
            content: { type: "string", description: "What this task should accomplish." },
          },
          required: ["id", "content"],
        },
      },
    },
    required: ["content", "todos"],
  },
  formatDisplay(args, result) {
    const count = Array.isArray(args.todos) ? args.todos.length : 0;
    const name = sanitizeName(String(args.name ?? "current-plan"));
    if (typeof result === "string") {
      const pathMatch = result.match(/Saved to (.+\.md)\./);
      if (pathMatch) {
        return `Created plan '${name}' (${count} todos) → ${pathMatch[1]}`;
      }
    }
    return `create_plan name=${name} todos=${count}`;
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const content = String(args.content ?? "").trim();
    const todos = normalizeTodos(args.todos);
    if (!content) return "Error: content is required.";
    if (!todos) return "Error: todos must be a non-empty array with id/content fields.";

    // Determine name — reuse existing pending plan name if not specified
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    const existing = findPendingPlans(homeDir);
    const name = sanitizeName(String(args.name ?? existing[0]?.name ?? "current-plan"));

    // Write plan file
    const mdPath = planFilePath(homeDir, name, "plan");
    await ctx.fs.writeText(mdPath, renderPlanMarkdown(name, content, todos));

    // Sync todos to teamboard (runtime working state)
    ctx.teamBoard.set(ctx.agentId, TODO_BOARD_KEY, todos, { persist: true });

    return (
      `Created plan '${name}' with ${todos.length} todo(s). ` +
      `Saved to ${mdPath}. ` +
      `Use \`review_plan\` to assess, then \`execute_plan\` to begin.`
    );
  },
} satisfies ToolDefinition;
