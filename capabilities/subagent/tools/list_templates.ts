/** @desc list_templates — discover available agent templates with usage metadata */

import { join } from "node:path";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

interface TemplateMeta {
  for?: string;
  whenToUse?: string;
}

interface TemplateEntry {
  name: string;
  for?: string;
  whenToUse?: string;
}

export default {
  name: "list_templates",
  description:
    "List available agent templates. Use before launching a subagent to discover " +
    "what types are available beyond the built-in observe/plan/act.",
  guidance:
    "**list_templates**: Call this first to find the best-fit template for your task, " +
    "then pass the template name as the subagent type.",
  input_schema: {
    type: "object",
    properties: {
      for: {
        type: "string",
        enum: ["subagent", "continuity"],
        description:
          "Filter by purpose: 'subagent' for disposable task agents, " +
          "'continuity' for persistent long-lived agents. Omit to list all.",
      },
    },
    required: [],
  },

  async execute(args: { for?: string }, ctx): Promise<ToolOutput> {
    const dirs = [
      ctx.pathManager.agent(ctx.agentId).templatesDir(),
      ctx.pathManager.team().templatesDir(),
      ctx.pathManager.instance().templatesDir(),
    ];

    const seen = new Set<string>();
    const templates: TemplateEntry[] = [];

    for (const dir of dirs) {
      let entries: string[];
      try { entries = ctx.fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry);
        const s = ctx.fs.statSync(full);
        if (!s?.isDirectory) continue;
        if (seen.has(entry)) continue;
        seen.add(entry);

        const meta = readTemplateMeta(ctx, full);
        if (args.for && meta.for && meta.for !== args.for) continue;

        templates.push({
          name: entry,
          ...(meta.for && { for: meta.for }),
          ...(meta.whenToUse && { whenToUse: meta.whenToUse }),
        });
      }
    }

    if (templates.length === 0) {
      return JSON.stringify({
        templates: [],
        hint: args.for
          ? `No templates found for "${args.for}". Try without filter.`
          : "No templates found.",
      });
    }
    return JSON.stringify({ templates });
  },
  serial: false,
} satisfies ToolDefinition;

function readTemplateMeta(ctx: { fs: { readTextSync(p: string): string } }, dir: string): TemplateMeta {
  try {
    const raw = ctx.fs.readTextSync(join(dir, "template.json"));
    const parsed = JSON.parse(raw);
    return {
      for: typeof parsed.for === "string" ? parsed.for : undefined,
      whenToUse: typeof parsed.whenToUse === "string" ? parsed.whenToUse : undefined,
    };
  } catch {
    return {};
  }
}
