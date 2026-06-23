import { mimeLookup } from "../lib/mime-lookup";
import { displayChalk as chalk } from "../lib/display-chalk";
import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";
import { fileToContentPart, isBinaryBuffer } from "../../../../src/utils/content-utils";
import { recordFileRead } from "../lib/file-state";

const MAX_CHARS = 256_000;
const MAX_LINE_LENGTH = 2000;
/** 防御性硬上限：避免一次性读 GB 级文件。常规截断由 MAX_CHARS 处理。 */
const HARD_SIZE_LIMIT = 512 * 1024 * 1024;
/** 未带 offset/limit 的文本文件：按 MAX_CHARS 估算需要读多少字节。 */
const READ_AHEAD_BYTES = MAX_CHARS * 2;

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero", "/dev/random", "/dev/urandom", "/dev/null",
  "/dev/stdin", "/dev/stdout", "/dev/stderr",
  "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",
  "/proc/kcore",
]);

function formatTextOutput(
  raw: string,
  offset: number | undefined,
  limit: number | undefined,
  _absPath: string,
): string {
  if (raw.length === 0) return "File is empty.";
  const allLines = raw.split("\n");
  const totalLines = allLines.length;

  let start: number;
  if (offset !== undefined && offset < 0) start = Math.max(0, totalLines + offset);
  else if (offset !== undefined) start = Math.max(0, offset - 1);
  else start = 0;

  const end = limit !== undefined ? Math.min(totalLines, start + limit) : totalLines;

  const numbered: string[] = [];
  let charCount = 0;
  let truncatedAtLine = -1;

  for (let i = start; i < end; i++) {
    let line = allLines[i];
    if (line.length > MAX_LINE_LENGTH) {
      line = line.slice(0, MAX_LINE_LENGTH) + ` [... truncated ${allLines[i].length - MAX_LINE_LENGTH} chars]`;
    }
    const formatted = `${String(i + 1).padStart(6)}|${line}\n`;
    if (charCount + formatted.length > MAX_CHARS && limit === undefined) {
      truncatedAtLine = i;
      break;
    }
    numbered.push(formatted);
    charCount += formatted.length;
  }

  const result = numbered.join("").trimEnd();

  if (truncatedAtLine !== -1) {
    return result + `\n\n[Output truncated: file has ${totalLines} lines (${raw.length} chars), showed lines ${start + 1}–${truncatedAtLine}. Use offset/limit to read the rest.]`;
  }
  if (end < totalLines && limit !== undefined) {
    return result + `\n\n[Showing lines ${start + 1}–${end} of ${totalLines} total.]`;
  }
  return result;
}

export default {
  name: "read_file",
  description:
    "Read a file from the workspace or host filesystem. " +
    "Absolute and relative paths (from CURRENT_DIR) are both accepted. " +
    "Supports text files with line-numbered output and media files (images, video, audio) returned as structured content. " +
    "Always read a file before editing. Read multiple related files in parallel for efficiency.",
  guidance: "**read_file**: Always read before editing or analyzing. Batch-read multiple files in parallel when possible.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute or relative to CURRENT_DIR, e.g. 'notes/todo.md')",
      },
      offset: {
        type: "integer",
        description: "Line number to start reading from (1-indexed). Negative counts from end.",
      },
      limit: {
        type: "integer",
        description: "Number of lines to read from the offset",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.fs.resolve(String(args.path));

    if (BLOCKED_DEVICE_PATHS.has(absPath) || absPath.startsWith("/dev/") || absPath.startsWith("/proc/")) {
      return `Error: reading device/proc paths is not allowed — ${absPath}`;
    }

    const fileStat = await ctx.fs.stat(absPath);
    if (!fileStat) return `Error: file not found — ${absPath}`;
    if (!fileStat.isFile) return `Error: not a regular file — ${absPath}`;
    if (fileStat.size > HARD_SIZE_LIMIT) {
      return `Error: file too large (${(fileStat.size / 1024 / 1024).toFixed(0)} MB). Maximum supported size is ${HARD_SIZE_LIMIT / 1024 / 1024} MB.`;
    }
    if (fileStat.size === 0) return "File is empty.";

    const isPartial = args.offset !== undefined || args.limit !== undefined;
    const needsFull = fileStat.size <= READ_AHEAD_BYTES || isPartial;
    const readBytes = needsFull ? undefined : READ_AHEAD_BYTES;

    let buf: Buffer;
    try {
      buf = await ctx.fs.readBinary(absPath, readBytes);
    } catch {
      return `Error: cannot read file — ${absPath}`;
    }

    const binary = isBinaryBuffer(buf);
    const mime = mimeLookup(absPath) || (binary ? "application/octet-stream" : "text/plain");
    const classified = fileToContentPart(absPath, mime, binary);

    if (classified.type !== "text_file") return [classified];

    const raw = buf.toString("utf-8");
    const isTruncated = !needsFull;
    await recordFileRead(absPath, 0, raw, isPartial || isTruncated, ctx.fs);
    return formatTextOutput(raw, args.offset as number | undefined, args.limit as number | undefined, absPath);
  },
  compactResult(_args, result) { return result; },
  formatDisplay(args, result) {
    const path = String(args.path);
    if (typeof result !== "string") return chalk.bold(path) + chalk.dim(" — media/binary");
    if (result.startsWith("Error") || result.startsWith("File is empty")) return result;
    const lineCount = result.split("\n").length;
    return chalk.bold(path) + chalk.dim(` — ${lineCount} lines`);
  },
  serial: false,
} satisfies ToolDefinition;
