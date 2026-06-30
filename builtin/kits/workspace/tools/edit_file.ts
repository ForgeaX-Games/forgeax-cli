import { displayChalk as chalk } from "../lib/display-chalk";
import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";
import { canWritePath } from "../lib/file-write-permissions";
import { checkStaleness, clearFileRead } from "../lib/file-state";
import { lineDiff } from "../lib/line-diff";
import { findActualString, applyEditToFile, preserveQuoteStyle, stripTrailingWhitespace } from "../lib/edit-utils";
import { getOperationLevel } from "../condition";

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;

export default {
  name: "edit_file",
  condition: (ctx) => getOperationLevel(ctx) !== "read-only",
  modelFilter: (model: string) => !/^gpt/i.test(model),
  description:
    "Perform exact string replacement in a file. " +
    "old_string must match file content exactly (whitespace and indentation included). " +
    "Include 3-5 surrounding lines in old_string to guarantee uniqueness. " +
    "If old_string is not unique, provide more context or set replace_all. " +
    "When constructing old_string from read_file output, strip the line-number prefix (e.g. '     1|'). " +
    "Use write_file as a fallback when repeated edit attempts fail.",
  guidance: "**edit_file**: On first failure, re-read and copy old_string exactly. On second failure, switch to write_file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to CURRENT_DIR)" },
      old_string: { type: "string", description: "The exact text to replace (must match file contents exactly)" },
      new_string: { type: "string", description: "The replacement text (must differ from old_string)" },
      replace_all: { type: "boolean", description: "Replace all occurrences of old_string (default: false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.fs.resolve(String(args.path));
    if (!canWritePath(absPath, ctx)) return `Permission denied: cannot write to ${absPath}`;

    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    const replaceAll = (args.replace_all as boolean) ?? false;

    if (oldStr === newStr) return "old_string and new_string are identical — nothing to change";

    const fileStat = await ctx.fs.stat(absPath);
    if (!fileStat) return `Error: file not found — ${absPath}`;
    if (fileStat.size > MAX_EDIT_FILE_SIZE) {
      return `Error: file too large for edit (${(fileStat.size / 1024 / 1024).toFixed(0)} MB, limit 1 GiB). Consider editing with shell tools or rewriting specific sections.`;
    }
    const staleMsg = await checkStaleness(absPath, ctx.fs);
    if (staleMsg) return staleMsg;

    let content: string;
    try { content = await ctx.fs.readText(absPath); }
    catch { return `Error: file not found — ${absPath}`; }

    const isMarkdown = /\.(md|mdx)$/i.test(absPath);
    const normalizedNewStr = isMarkdown ? newStr : stripTrailingWhitespace(newStr);

    const actualOldStr = findActualString(content, oldStr);
    if (!actualOldStr) {
      return `old_string not found in ${absPath}. Make sure the text matches exactly, including whitespace and indentation. Hint: Re-read the file with read_file and copy the exact text. If this keeps failing, use write_file to rewrite the entire file.`;
    }

    const occurrences = content.split(actualOldStr).length - 1;
    if (occurrences > 1 && !replaceAll) {
      return `old_string found ${occurrences} times in ${absPath}. Provide more context to make it unique, or use replace_all.`;
    }

    const actualNewStr = preserveQuoteStyle(oldStr, actualOldStr, normalizedNewStr);
    const startLine = content.slice(0, content.indexOf(actualOldStr)).split("\n").length;
    const updated = applyEditToFile(content, actualOldStr, actualNewStr, replaceAll);

    try { await ctx.fs.writeText(absPath, updated); }
    catch (e: any) { return `Error: failed to write file — ${e.message}`; }

    clearFileRead(absPath, undefined, updated, ctx.fs);
    return `Edited ${absPath}: replaced ${replaceAll ? occurrences : 1} occurrence${(replaceAll && occurrences > 1) ? "s" : ""} @line:${startLine}`;
  },
  compactResult(_args, result) { return result; },
  formatDisplay(args, result) {
    const path = String(args.path);
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error") || res.startsWith("old_string") || res.startsWith("Permission") || res.startsWith("File has been")) return res;

    const lineMatch = res.match(/@line:(\d+)/);
    const startLine = lineMatch ? Number(lineMatch[1]) - 1 : 0;
    const displayRes = res.replace(/\s*@line:\d+/, "");

    const old = String(args.old_string);
    const neu = String(args.new_string);
    const diffs = lineDiff(old, neu);
    const lines: string[] = [chalk.bold(path) + chalk.dim(` — ${displayRes}`)];

    for (const d of diffs) {
      const ln = String(d.lineNo + startLine).padStart(3);
      if (d.type === "del") lines.push(chalk.red(`- ${ln} ${d.line}`));
      else if (d.type === "add") lines.push(chalk.green(`+ ${ln} ${d.line}`));
    }
    return lines.join("\n");
  },
} satisfies ToolDefinition;
