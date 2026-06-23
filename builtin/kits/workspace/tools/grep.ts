import { displayChalk as chalk } from "../lib/display-chalk";
import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";

const MAX_OUTPUT_CHARS = 80_000;

type OutputMode = "content" | "files_with_matches" | "count";

export default {
  name: "grep",
  description:
    "Search file contents using regex. Returns matching lines with paths and line numbers. " +
    "Skips binary files, node_modules, .git, dist, symlinks, and hidden directories. " +
    "ALWAYS use this instead of shell grep/rg. " +
    "Supports full regex syntax. Use glob for filename search instead.",
  guidance: "**grep**: Preferred over shell grep/rg. Use output_mode='files_with_matches' for file-only results.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for (e.g. 'TODO', 'function\\s+\\w+')" },
      path: { type: "string", description: "Directory or file to search in. Relative paths resolve from CURRENT_DIR. Defaults to CURRENT_DIR." },
      case_insensitive: { type: "boolean", description: "Case insensitive search. Default: false" },
      context_lines: { type: "integer", description: "Number of context lines before/after each match. Default: 0" },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output mode: 'content' shows matching lines (default), 'files_with_matches' shows only file paths, 'count' shows match counts per file",
      },
      glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts', '*.{js,jsx}')" },
      head_limit: { type: "integer", description: "Maximum number of result lines to return. Default: 500" },
      offset: { type: "integer", description: "Skip the first N result lines (for pagination). Default: 0" },
      multiline: { type: "boolean", description: "Enable multiline matching where patterns can span lines. Default: false" },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const pattern = String(args.pattern);
    const caseInsensitive = !!args.case_insensitive;
    const contextLines = (args.context_lines as number) ?? 0;
    const outputMode = (args.output_mode as OutputMode) ?? "content";
    const globFilter = args.glob ? String(args.glob) : undefined;
    const headLimit = (args.head_limit as number) ?? 500;
    const offset = (args.offset as number) ?? 0;
    const multiline = !!args.multiline;

    const searchPath = ctx.fs.resolve(String(args.path ?? "."));
    const stat = await ctx.fs.stat(searchPath);
    if (!stat) return `Error: path does not exist — ${searchPath}`;

    let raw: string;
    try {
      raw = await ctx.fs.grep(searchPath, pattern, {
        caseInsensitive, contextLines, outputMode,
        glob: globFilter, multiline,
      });
    } catch (e: any) {
      return `Error: grep failed — ${e.message}`;
    }

    if (!raw.trim()) return `No matches found for pattern: ${pattern}`;

    const lines = raw.split("\n");
    const sliced = lines.slice(offset, offset + headLimit);
    let output = sliced.join("\n").trim();

    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS);
      output += `\n\n[Output truncated at ${MAX_OUTPUT_CHARS} chars. Narrow your search pattern or path.]`;
    }
    if (sliced.length < lines.length) {
      output += `\n\n[Showing ${sliced.length} of ${lines.length} result lines. Use offset/head_limit to paginate.]`;
    }
    return output;
  },
  compactResult(args) { return `[grep pattern="${args.pattern}" path="${args.path ?? "."}"]`; },
  formatDisplay(args, result) {
    const pattern = String(args.pattern);
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("No matches") || res.startsWith("Error") || res.startsWith("Invalid") || res.startsWith("Path not found"))
      return res;

    const resultLines = res.split("\n").filter((l) => l.trim());
    const total = resultLines.length;
    const MAX_PREVIEW = 5;
    const preview = resultLines.slice(0, MAX_PREVIEW);

    const header = chalk.cyan(pattern) + chalk.dim(` — ${total} result lines`);
    if (total === 0) return header;

    const body = preview.map((l) => chalk.dim(l));
    if (total > MAX_PREVIEW) body.push(chalk.dim(`  ... (${total - MAX_PREVIEW} more)`));
    return [header, ...body].join("\n");
  },
  serial: false,
} satisfies ToolDefinition;
