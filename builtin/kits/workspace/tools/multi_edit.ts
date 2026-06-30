import { displayChalk as chalk } from "../lib/display-chalk";
import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";
import { canWritePath } from "../lib/file-write-permissions";
import { checkStaleness, clearFileRead } from "../lib/file-state";
import { lineDiff } from "../lib/line-diff";
import { findActualString, applyEditToFile, preserveQuoteStyle, stripTrailingWhitespace } from "../lib/edit-utils";
import { getOperationLevel } from "../condition";

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;

interface EditOp {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export default {
  name: "multi_edit",
  condition: (ctx) => getOperationLevel(ctx) !== "read-only",
  modelFilter: (model: string) => !/^gpt/i.test(model),
  description:
    "Apply multiple find-and-replace edits to a single file atomically. " +
    "Each old_string must match the current file content at that step exactly (whitespace and indentation included). " +
    "Edits are applied sequentially — each operates on the result of the previous. " +
    "If any edit fails, none are applied. " +
    "Prefer this over multiple edit_file calls when changing several locations in the same file. " +
    "When constructing old_string from read_file output, strip the line-number prefix (e.g. '     1|').",
  guidance: "**multi_edit**: Prefer over multiple edit_file calls for same-file changes — atomic and context-efficient.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to CURRENT_DIR)" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "The exact text to replace at this step (must match current content exactly)" },
            new_string: { type: "string", description: "The replacement text (must differ from old_string)" },
            replace_all: { type: "boolean", description: "Replace all occurrences (default: false)" },
          },
          required: ["old_string", "new_string"],
        },
        minItems: 1,
        description: "Array of edit operations to apply sequentially.",
      },
    },
    required: ["path", "edits"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.fs.resolve(String(args.path));
    if (!canWritePath(absPath, ctx)) return `Permission denied: cannot write to ${absPath}`;

    const rawEdits = args.edits;
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) return "Error: edits must be a non-empty array.";
    for (let i = 0; i < rawEdits.length; i++) {
      const edit = rawEdits[i] as Record<string, unknown> | undefined;
      if (typeof edit?.old_string !== "string" || typeof edit?.new_string !== "string") {
        return `Error: edit ${i + 1}/${rawEdits.length} must include string old_string and new_string. No edits applied.`;
      }
    }
    const edits = rawEdits as EditOp[];

    const fileStat = await ctx.fs.stat(absPath);
    if (!fileStat) return `Error: file not found — ${absPath}`;
    if (fileStat.size > MAX_EDIT_FILE_SIZE) {
      return `Error: file too large for edit (${(fileStat.size / 1024 / 1024).toFixed(0)} MB, limit 1 GiB).`;
    }
    const staleMsg = await checkStaleness(absPath, ctx.fs);
    if (staleMsg) return staleMsg;

    let content: string;
    try { content = await ctx.fs.readText(absPath); }
    catch { return `Error: file not found — ${absPath}`; }

    const isMarkdown = /\.(md|mdx)$/i.test(absPath);
    const startLines: number[] = [];

    for (let i = 0; i < edits.length; i++) {
      const { old_string, new_string, replace_all } = edits[i];
      if (old_string === new_string) {
        return `Edit ${i + 1}/${edits.length} failed: old_string and new_string are identical. No edits applied.`;
      }
      const normalizedNewStr = isMarkdown ? new_string : stripTrailingWhitespace(new_string);
      const actualOldStr = findActualString(content, old_string);
      if (!actualOldStr) {
        return `Edit ${i + 1}/${edits.length} failed: old_string not found in ${absPath}. No edits applied.`;
      }
      const occurrences = content.split(actualOldStr).length - 1;
      if (occurrences > 1 && !replace_all) {
        return `Edit ${i + 1}/${edits.length} failed: old_string found ${occurrences} times in ${absPath}. Provide more context to make it unique, or use replace_all. No edits applied.`;
      }
      const actualNewStr = preserveQuoteStyle(old_string, actualOldStr, normalizedNewStr);
      startLines.push(content.slice(0, content.indexOf(actualOldStr)).split("\n").length);
      content = applyEditToFile(content, actualOldStr, actualNewStr, replace_all ?? false);
    }

    try { await ctx.fs.writeText(absPath, content); }
    catch (e: any) { return `Error: failed to write file — ${e.message}`; }
    clearFileRead(absPath, undefined, content, ctx.fs);
    return `Applied ${edits.length} edit${edits.length > 1 ? "s" : ""} to ${absPath} @lines:${startLines.join(",")}`;
  },
  compactResult(_args, result) { return result; },
  formatDisplay(args, result) {
    const path = String(args.path);
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error") || res.startsWith("Edit") || res.startsWith("Permission")) return res;

    const linesMatch = res.match(/@lines:([\d,]+)/);
    const startLines = linesMatch ? linesMatch[1].split(",").map(Number) : [];
    const displayRes = res.replace(/\s*@lines:[\d,]+/, "");

    const edits = (args.edits ?? []) as EditOp[];
    const lines: string[] = [chalk.bold(path) + chalk.dim(` — ${displayRes}`)];

    for (let ei = 0; ei < edits.length; ei++) {
      const edit = edits[ei];
      const startLine = (startLines[ei] ?? 1) - 1;
      const diffs = lineDiff(edit.old_string, edit.new_string);
      for (const d of diffs) {
        const ln = String(d.lineNo + startLine).padStart(3);
        if (d.type === "del") lines.push(chalk.red(`- ${ln} ${d.line}`));
        else if (d.type === "add") lines.push(chalk.green(`+ ${ln} ${d.line}`));
      }
    }
    return lines.join("\n");
  },
} satisfies ToolDefinition;
