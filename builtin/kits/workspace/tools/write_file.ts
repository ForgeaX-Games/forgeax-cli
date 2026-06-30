import { displayChalk as chalk } from "../lib/display-chalk";
import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";
import { canWritePath } from "../lib/file-write-permissions";
import { checkStaleness, clearFileRead } from "../lib/file-state";
import { getOperationLevel } from "../condition";

export default {
  name: "write_file",
  condition: (ctx) => getOperationLevel(ctx) !== "read-only",
  description:
    "Write content to a file, creating parent directories as needed. " +
    "Overwrites existing files — always read_file first when modifying. " +
    "Prefer edit_file for targeted changes; use write_file for new files or full rewrites.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path. Relative paths resolve from CURRENT_DIR." },
      contents: { type: "string", description: "The full content to write to the file" },
    },
    required: ["path", "contents"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.fs.resolve(String(args.path));
    const contents = String(args.contents);

    if (!canWritePath(absPath, ctx)) return `Permission denied: cannot write to ${absPath}`;

    const staleMsg = await checkStaleness(absPath, ctx.fs);
    if (staleMsg) return staleMsg;

    const existing = await ctx.fs.stat(absPath);
    if (existing?.isFile) {
      try {
        const oldContent = await ctx.fs.readText(absPath);
        if (oldContent === contents) {
          return `Warning: content identical to existing file — no changes were made to ${absPath}. Use edit_file for targeted modifications, or ensure the content you're writing is actually different.`;
        }
      } catch { /* unreadable, proceed */ }
    }

    try {
      await ctx.fs.writeText(absPath, contents);
    } catch (e: any) {
      return `Error: failed to write file — ${e.message}`;
    }

    clearFileRead(absPath, undefined, contents, ctx.fs);
    return `Wrote ${contents.length} bytes to ${absPath}`;
  },
  compactResult(_args, result) { return result; },
  formatDisplay(args, result) {
    const path = String(args.path);
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error") || res.startsWith("Permission") || res.startsWith("Warning") || res.startsWith("File has been"))
      return res;
    const content = String(args.contents ?? "");
    const lines = content.split("\n").length;
    return chalk.bold(path) + chalk.dim(` — written (${lines} lines)`);
  },
} satisfies ToolDefinition;
