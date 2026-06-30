import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";

export default {
  name: "list_dir",
  description:
    "List directory contents with [dir] and [file] markers. " +
    "Prefer glob for pattern-based file search and grep for content search.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (absolute or relative to CURRENT_DIR). Defaults to CURRENT_DIR." },
    },
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const dirPath = ctx.fs.resolve(String(args.path ?? "."));
    const stat = await ctx.fs.stat(dirPath);
    if (!stat) return `Error: path does not exist — ${dirPath}`;
    if (!stat.isDirectory) return `Error: path is not a directory — ${dirPath}`;
    try {
      const lines = await ctx.fs.listDir(dirPath);
      if (lines.length === 0) return `${dirPath} is empty`;
      return `${dirPath}\n${lines.join("\n")}`;
    } catch (e: any) {
      return `Error: cannot list directory — ${dirPath} (${e.message})`;
    }
  },
  serial: false,
} satisfies ToolDefinition;
