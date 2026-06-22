import fg from "fast-glob";
import { displayChalk as chalk } from "../lib/display-chalk.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

const GLOB_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 500;

export default {
  name: "glob",
  description:
    "Fast file pattern matching. Returns matching file paths sorted by modification time (most recent first). " +
    "Simple patterns are auto-prepended with '**/' for recursive search. " +
    "Supports brace expansion ({a,b}), character classes, and standard glob syntax. " +
    "Skips node_modules, .git, dist. Batch multiple searches in parallel for efficiency.",
  guidance: "**glob**: Preferred over shell find for filename search. Use grep for content search instead.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match files (e.g. '*.ts', '**/*.json', 'src/**/*.ts', '{a,b}/*.js')",
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

    // Early exit if path does not exist — avoids silent empty results
    const stat = await ctx.fs.stat(baseDir);
    if (!stat) return `Error: path does not exist — ${baseDir}`;
    if (!stat.isDirectory) return `Error: path is not a directory — ${baseDir}`;

    if (ctx.fs.needsProxy(baseDir)) {
      try {
        const matched = await ctx.fs.glob(baseDir, pattern);
        if (matched.length === 0) return `No files matched pattern: ${pattern}`;
        const sorted = matched.sort();
        if (sorted.length > MAX_RESULTS) {
          return sorted.slice(0, MAX_RESULTS).join("\n") +
            `\n\n[Showing ${MAX_RESULTS} of ${sorted.length} matches. Narrow your pattern or path to see more.]`;
        }
        return `${sorted.join("\n")}\n\n(${sorted.length} file${sorted.length === 1 ? "" : "s"} matched)`;
      } catch (e: any) {
        return `Error: container glob failed — ${e.message}`;
      }
    }

    try {
      const matched = await Promise.race([
        fg(pattern, {
          cwd: baseDir,
          dot: pattern.includes("/.") || /(?:^|\/)\./.test(pattern),
          ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/__pycache__/**", "**/.cache/**"],
          followSymbolicLinks: false,
          onlyFiles: true,
          stats: true,
          absolute: false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("glob timed out")), GLOB_TIMEOUT_MS),
        ),
      ]);

      if (matched.length === 0) return `No files matched pattern: ${pattern}`;

      // Sort by modification time (most recent first)
      const sorted = matched
        .sort((a, b) => {
          const mtA = (a as any).stats?.mtimeMs ?? 0;
          const mtB = (b as any).stats?.mtimeMs ?? 0;
          return mtB - mtA;
        })
        .map((entry) => typeof entry === "string" ? entry : entry.path);

      if (sorted.length > MAX_RESULTS) {
        return sorted.slice(0, MAX_RESULTS).join("\n") +
          `\n\n[Showing ${MAX_RESULTS} of ${sorted.length} matches. Narrow your pattern or path to see more.]`;
      }
      return `${sorted.join("\n")}\n\n(${sorted.length} file${sorted.length === 1 ? "" : "s"} matched)`;
    } catch (err: any) {
      if (err.message === "glob timed out") {
        return `Error: glob timed out after ${GLOB_TIMEOUT_MS / 1000}s. Directory may contain too many files — use a more specific path.`;
      }
      return `Error: glob failed — ${err.message}`;
    }
  },
  compactResult(args) {
    return `[glob pattern="${args.pattern}" path="${args.path ?? "."}"]`;
  },
  formatDisplay(args, result) {
    const pattern = String(args.pattern);
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("No files") || res.startsWith("Error")) return res;

    const countMatch = res.match(/\((\d+) files? matched\)/);
    const count = countMatch ? countMatch[1] : "?";
    const files = res.split("\n").filter(l => l.trim() && !l.startsWith("(") && !l.startsWith("["));
    const preview = files.slice(0, 3).join(", ");
    const more = files.length > 3 ? ", ..." : "";

    return chalk.cyan(pattern) + chalk.dim(` — ${count} files`) +
      (preview ? "\n" + chalk.dim(preview + more) : "");
  },
  serial: false,
} satisfies ToolDefinition;
