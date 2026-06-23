// @desc Edit a plan's body (find-replace or full) and todos (merge by id)
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { displayChalk as chalk } from "../../workspace/lib/display-chalk.js";
import { findPendingPlans, scanPlansSync } from "../lib/plan-files.js";
import { TODO_BOARD_KEY, type TodoItem } from "./create_plan.js";

/** Split plan markdown into body (before ## Todos) and todos section (## Todos onward). */
function splitPlanSections(content: string): { body: string; todosSection: string } {
  const idx = content.indexOf("\n## Todos");
  if (idx === -1) return { body: content, todosSection: "" };
  return { body: content.slice(0, idx), todosSection: content.slice(idx) };
}

/** Render todos back into markdown lines. */
function renderTodosMarkdown(todos: TodoItem[]): string {
  const lines = ["\n## Todos\n"];
  for (const t of todos) {
    const check = t.status === "completed" ? "x" : " ";
    lines.push(`- [${check}] **${t.id}**: ${t.content}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Parse todos from the ## Todos section of a plan file. */
function parseTodosFromSection(section: string): TodoItem[] {
  const todos: TodoItem[] = [];
  const re = /^- \[([x ])\] \*\*(\S+?)\*\*:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    todos.push({
      id: m[2],
      content: m[3].trim(),
      status: m[1] === "x" ? "completed" : "pending",
    });
  }
  return todos;
}

export default {
  name: "edit_plan",
  description:
    "Edit an active plan's body text or todos without recreating the entire plan. " +
    "Use 'body' to replace the plan content (before ## Todos). " +
    "Use 'old_string'+'new_string' for precise find-and-replace within the body. " +
    "Use 'todos' to incrementally add, remove, or update todo items.",
  guidance:
    "**edit_plan**: For incremental plan changes. Use body to update approach/context, " +
    "old_string/new_string for precise edits (like edit_file), " +
    "todos to add/remove/modify tasks. Changes sync to both the .plan.md file and TeamBoard.",
  condition(ctx) {
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;
    return findPendingPlans(homeDir).length > 0;
  },
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Plan name to edit (must match an existing .plan.md file).",
      },
      body: {
        type: "string",
        description:
          "New plan body content (replaces everything before ## Todos). " +
          "Omit to keep existing body unchanged.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to find in plan body for precise replacement (used with new_string). " +
          "Mutually exclusive with 'body'.",
      },
      new_string: {
        type: "string",
        description: "Replacement text for old_string match.",
      },
      todos: {
        type: "array",
        description:
          "Incremental todo edits. Each item specifies an id and optional content/status. " +
          "New ids are added, existing ids are updated. Set status to 'cancelled' to remove.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Todo id (e.g. t1, t2)" },
            content: { type: "string", description: "Todo description (omit when only updating status)" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "Todo status. Use 'cancelled' to remove from plan.",
            },
          },
          required: ["id"],
        },
      },
    },
    required: ["name"],
  },
  formatDisplay(args, result) {
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error")) return chalk.red(res);

    const name = String(args.name ?? "");
    const parts: string[] = [];
    if (args.body) parts.push("body replaced");
    if (args.old_string) parts.push("find-replace");
    if (Array.isArray(args.todos)) {
      const n = (args.todos as unknown[]).length;
      parts.push(`${n} todo${n > 1 ? "s" : ""}`);
    }
    const mode = parts.length > 0 ? parts.join(", ") : "no changes";

    // Parse line stats from result metadata
    const linesMatch = res.match(/@lines:(\d+)\u2192(\d+)/);
    const todoMatch = res.match(/@todos:(\d+)\/(\d+)/);
    const stats: string[] = [];
    if (linesMatch) {
      const [, before, after] = linesMatch;
      const delta = Number(after) - Number(before);
      const sign = delta > 0 ? "+" : "";
      stats.push(`${before}\u2192${after} lines (${sign}${delta})`);
    }
    if (todoMatch) stats.push(`${todoMatch[1]}/${todoMatch[2]} todos done`);

    const pathMatch = res.match(/Saved to (.+\.md)\./);
    const pathStr = pathMatch ? ` → ${pathMatch[1]}` : "";

    return chalk.bold(name) + chalk.dim(` \u2014 ${mode}`) + (stats.length > 0 ? chalk.dim(` \u2014 ${stats.join(", ")}`) : "") + pathStr;
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const homeDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.HOME_DIR) as string;

    // Validate required name
    const name = typeof args.name === "string" ? (args.name as string).trim() : "";
    if (!name) return "Error: 'name' is required. Specify which plan to edit.";

    // Validate mutually exclusive body modes
    if (typeof args.body === "string" && typeof args.old_string === "string") {
      return "Error: 'body' and 'old_string' are mutually exclusive. Use 'body' for full replacement or 'old_string'+'new_string' for precise replacement.";
    }
    if (typeof args.old_string === "string" && typeof args.new_string !== "string") {
      return "Error: 'new_string' is required when using 'old_string'.";
    }

    // Find the plan by name
    const plan = scanPlansSync(homeDir).find((p) => p.name === name && p.status === "plan");
    if (!plan) {
      const pending = findPendingPlans(homeDir);
      const available = pending.map((p) => p.name).join(", ") || "(none)";
      return `Error: no pending plan named '${name}'. Available: ${available}`;
    }

    // Read current file
    let content: string;
    try {
      content = getSandboxFs().readTextSync(plan.path);
    } catch {
      return `Error: could not read plan file at ${plan.path}`;
    }

    const { body: currentBody, todosSection } = splitPlanSections(content);
    let currentTodos = parseTodosFromSection(todosSection);

    const changes: string[] = [];

    // ── Body edit mode 1: full replacement ──
    let newBody = currentBody;
    if (typeof args.body === "string") {
      const bodyText = (args.body as string).trim();
      if (!bodyText) return "Error: body cannot be empty.";
      const titleMatch = currentBody.match(/^# .+\n/);
      const title = titleMatch ? titleMatch[0] : `# ${plan.name}\n`;
      newBody = title + "\n" + bodyText;
      changes.push("body replaced");
    }

    // ── Body edit mode 2: precise find-and-replace ──
    if (typeof args.old_string === "string") {
      const oldStr = args.old_string as string;
      const newStr = (args.new_string as string) ?? "";
      if (!currentBody.includes(oldStr)) {
        return `Error: old_string not found in plan body. Read the plan first to get exact text.`;
      }
      const count = currentBody.split(oldStr).length - 1;
      if (count > 1) {
        return `Error: old_string found ${count} times in plan body. Provide more context to make it unique.`;
      }
      newBody = currentBody.replace(oldStr, newStr);
      changes.push("body edited (find-replace)");
    }

    // ── Todos: merge by id (same as todo_write semantics) ──
    if (Array.isArray(args.todos)) {
      for (const edit of args.todos as Array<Record<string, unknown>>) {
        const id = String(edit.id ?? "").trim();
        if (!id) continue;

        const existing = currentTodos.find((t) => t.id === id);

        if (edit.status === "cancelled") {
          currentTodos = currentTodos.filter((t) => t.id !== id);
          changes.push(`todo ${id} removed`);
          continue;
        }

        if (existing) {
          if (typeof edit.content === "string") existing.content = String(edit.content);
          if (typeof edit.status === "string") existing.status = edit.status as TodoItem["status"];
          changes.push(`todo ${id} updated`);
        } else {
          const newContent = typeof edit.content === "string" ? String(edit.content) : "";
          if (!newContent) {
            changes.push(`todo ${id} skipped (no content for new item)`);
            continue;
          }
          currentTodos.push({
            id,
            content: newContent,
            status: (edit.status as TodoItem["status"]) ?? "pending",
          });
          changes.push(`todo ${id} added`);
        }
      }
    }

    if (changes.length === 0) {
      return "No changes specified. Provide 'body' or 'old_string'+'new_string' for body edits, and/or 'todos' for todo edits.";
    }

    // Write updated file
    const newContent = newBody + renderTodosMarkdown(currentTodos);
    getSandboxFs().writeTextSync(plan.path, newContent);

    // Sync todos to TeamBoard
    ctx.teamBoard.set(ctx.agentId, TODO_BOARD_KEY, currentTodos, { persist: true });

    // Stats for formatDisplay
    const oldLines = content.split("\n").length;
    const newLines = newContent.split("\n").length;
    const doneCount = currentTodos.filter((t) => t.status === "completed").length;
    const totalCount = currentTodos.length;

    return `Plan '${plan.name}' updated: ${changes.join(", ")}. Saved to ${plan.path}. @lines:${oldLines}\u2192${newLines} @todos:${doneCount}/${totalCount}`;
  },
} satisfies ToolDefinition;
