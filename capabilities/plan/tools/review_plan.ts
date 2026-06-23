// @desc Review a plan file by dispatching a review subagent via agent_command
import { join } from "node:path";
import type { AgentFsAPI } from "#src/sandbox/fs-bridge.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";

const TEMPLATE = "review";

// ─── Principles loader ──────────────────────────────────────────────────────

async function collectPrinciples(fs: AgentFsAPI, instanceRoot: string): Promise<string> {
  const dir = join(instanceRoot, "docs", "principles");
  const files: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries: string[];
    try { entries = await fs.listDir(d); } catch { return; }
    for (const line of entries) {
      const isDir = line.startsWith("[dir]");
      const name = line.replace(/^\[(dir|file)]\s+/, "");
      const full = join(d, name);
      if (isDir) await walk(full);
      else if (name.endsWith(".md")) files.push(full);
    }
  }

  await walk(dir);
  if (files.length === 0) return "";
  files.sort();

  const parts: string[] = [];
  for (const f of files) {
    try { parts.push((await fs.readText(f)).trim()); } catch { /* skip */ }
  }
  return parts.join("\n\n---\n\n");
}

// ─── Tool definition ────────────────────────────────────────────────────────

export default {
  name: "review_plan",
  description:
    "Dispatch a review subagent (via the standard subagent tool) that evaluates a plan file " +
    "against project principles (docs/principles/). The review result arrives in the next turn.",
  guidance:
    "**review_plan**: Use after `create_plan` to get an independent assessment. " +
    "Pass the plan file path. A review subagent is launched through the standard subagent tool; " +
    "review results will arrive as the subagent's foreground output in the next command turn.",
  condition(ctx) {
    return ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.STATUS) === "plan_mode";
  },
  input_schema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description: "Path to the .plan.md file to review.",
      },
      focus: {
        type: "string",
        description: "Optional focus area for the reviewer (e.g. 'architecture', 'testing').",
      },
    },
    required: ["plan"],
  },
  formatDisplay(args) {
    const plan = String(args.plan ?? "").split("/").pop() ?? "plan";
    const focus = args.focus ? ` focus=${String(args.focus)}` : "";
    return `review_plan ${plan}${focus}`;
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const planPath = String(args.plan ?? "").trim();
    if (!planPath) return "Error: plan file path is required.";

    let planContent: string;
    try {
      planContent = (await ctx.fs.readText(planPath)).trim();
    } catch (err: any) {
      return `Error: cannot read plan file '${planPath}': ${err.message ?? String(err)}`;
    }
    if (!planContent) return `Error: plan file '${planPath}' is empty.`;

    const instanceRoot = ctx.pathManager.instance().root();
    const principles = await collectPrinciples(ctx.fs, instanceRoot);

    const taskParts = [
      "You are reviewing a plan for quality and readiness.",
      `Plan file: ${planPath}`,
      "",
    ];
    if (principles) {
      taskParts.push("<principles>", principles, "</principles>", "");
    } else {
      taskParts.push("(No project principles found — review based on general best practices.)", "");
    }
    taskParts.push("<plan>", planContent, "</plan>", "");

    const focus = String(args.focus ?? "").trim();
    if (focus) taskParts.push(`**Focus area**: ${focus}`, "");

    taskParts.push(
      "Evaluate this plan against the principles. Check each task for executability, " +
      "dependency completeness, risk coverage, and principle compliance.",
      "",
      "Output your structured review with verdict (ready / revise / replan), assessment, issues, and recommendations.",
    );

    ctx.eventBus.emit({
      source: "tool:review_plan",
      type: "agent_command",
      payload: {
        toolName: "subagent",
        args: {
          task: taskParts.join("\n"),
          type: TEMPLATE,
          mode: "foreground",
        },
        agentId: ctx.agentId,
        interrupt: false,
      },
      ts: Date.now(),
    });

    const planName = planPath.split("/").pop() ?? "plan";
    return `Review dispatched for ${planName}. The standard subagent tool will handle the review lifecycle; results arrive in the next turn.`;
  },
} satisfies ToolDefinition;
