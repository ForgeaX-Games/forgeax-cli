import { displayChalk as chalk } from "../lib/display-chalk";
import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";

const MAX_RESULTS = 500;

export default {
  name: "glob",
  description:
    "Fast file pattern matching. Returns matching file paths sorted by modification time (most recent first). " +
    "Simple patterns are auto-prepended with '**/' for recursive search. " +
    "Supports brace expansion ({a,b}) and standard glob syntax. " +
    "Skips node_modules, .git, dist. Batch multiple searches in parallel for efficiency.",
  guidance: "**glob**: Preferred over shell find for filename search. Use grep for content search instead.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match files (e.g. '*.ts', '**/*.json', 'src/**/*.ts', '{a,b}/*.js')",
      },
      path: {
        type: "string",
        description: "Base directory to search from. Relative paths resolve from CURRENT_DIR. Defaults to CURRENT_DIR.",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    let pattern = String(args.pattern);
    if (!pattern.startsWith("**/") && !pattern.startsWith("/") && !pattern.includes("/")) {
      pattern = "**/" + pattern;
    }

    const baseDir = ctx.fs.resolve(String(args.path ?? "."));
    const stat = await ctx.fs.stat(baseDir);
    if (!stat) return `Error: path does not exist — ${baseDir}`;
    if (!stat.isDirectory) return `Error: path is not a directory — ${baseDir}`;

    try {
      const matched = await ctx.fs.glob(baseDir, pattern);
      if (matched.length === 0) return `No files matched pattern: ${pattern}`;
      if (matched.length > MAX_RESULTS) {
        return matched.slice(0, MAX_RESULTS).join("\n") +
          `\n\n[Showing ${MAX_RESULTS} of ${matched.length} matches. Narrow your pattern or path to see more.]`;
      }
      return `${matched.join("\n")}\n\n(${matched.length} file${matched.length === 1 ? "" : "s"} matched)`;
    } catch (err: any) {
      return `Error: glob failed — ${err.message}`;
    }
  },
  compactResult(args) { return `[glob pattern="${args.pattern}" path="${args.path ?? "."}"]`; },
  formatDisplay(args, result) {
    const pattern = String(args.pattern);
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("No files") || res.startsWith("Error")) return res;
    const countMatch = res.match(/\((\d+) files? matched\)/);
    const count = countMatch ? countMatch[1] : "?";
    const files = res.split("\n").filter((l) => l.trim() && !l.startsWith("(") && !l.startsWith("["));
    const preview = files.slice(0, 3).join(", ");
    const more = files.length > 3 ? ", ..." : "";
    return chalk.cyan(pattern) + chalk.dim(` — ${count} files`) +
      (preview ? "\n" + chalk.dim(preview + more) : "");
  },
  serial: false,
} satisfies ToolDefinition;
