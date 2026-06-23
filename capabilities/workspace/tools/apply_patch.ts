// @desc GPT-oriented apply_patch — validated text patch writer for Add/Update file edits
import { displayChalk as chalk } from "../lib/display-chalk.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { canWritePath } from "../lib/file-write-permissions.js";
import { checkStaleness, clearFileRead } from "../lib/file-state.js";
import { getOperationLevel } from "../condition.js";

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB
const MAX_VISUAL_FILES = 8;
const MAX_VISUAL_DIFF_LINES = 80;
const MAX_VISUAL_LINE_CHARS = 200;

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  mode: "update" | "add" | "delete";
  hunks: Hunk[];
}

interface PlannedWrite {
  absPath: string;
  result: string;
  mode: "update" | "add";
}

function normalizePatchPath(path: string): string {
  const p = path.trim();
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

function parsePatch(raw: string): FilePatch[] {
  const lines = raw.split(/\r?\n/);
  const begin = lines.indexOf("*** Begin Patch");
  const end = lines.lastIndexOf("*** End Patch");
  if (begin === -1 || end === -1 || begin >= end) return [];

  const block = lines.slice(begin + 1, end);
  const files: FilePatch[] = [];
  let i = 0;

  while (i < block.length) {
    if (!block[i].startsWith("--- ")) { i++; continue; }

    const oldPath = normalizePatchPath(block[i].slice(4));
    i++;
    if (i >= block.length || !block[i].startsWith("+++ ")) break;
    const newPathRaw = normalizePatchPath(block[i].slice(4));
    i++;

    const mode: FilePatch["mode"] = oldPath === "/dev/null"
      ? "add"
      : newPathRaw === "/dev/null" ? "delete" : "update";
    const newPath = mode === "delete" ? oldPath : newPathRaw;
    const hunks: Hunk[] = [];

    while (i < block.length && !block[i].startsWith("--- ")) {
      const header = block[i];
      if (!header.startsWith("@@")) { i++; continue; }

      const match = header.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (!match) throw new Error(`Invalid hunk header: ${header}`);
      const hunk: Hunk = {
        oldStart: Number(match[1]),
        oldCount: match[2] ? Number(match[2]) : 1,
        newStart: Number(match[3]),
        newCount: match[4] ? Number(match[4]) : 1,
        lines: [],
      };
      i++;
      while (i < block.length && !block[i].startsWith("@@") && !block[i].startsWith("--- ")) {
        hunk.lines.push(block[i]);
        i++;
      }
      hunks.push(hunk);
    }

    files.push({ oldPath, newPath, mode, hunks });
  }

  return files;
}

function hunkMatches(content: string[], start: number, hunk: Hunk): boolean {
  let idx = start;
  for (const line of hunk.lines) {
    if (line.startsWith("+")) continue;
    const expected = line.startsWith("-") || line.startsWith(" ") ? line.slice(1) : line;
    if (idx >= content.length || content[idx] !== expected) return false;
    idx++;
  }
  return true;
}

function applyHunk(content: string[], hunk: Hunk): string[] | null {
  const preferred = hunk.oldStart - 1;
  let match = -1;

  for (let i = Math.max(0, preferred - 5); i <= Math.min(content.length, preferred + 5); i++) {
    if (hunkMatches(content, i, hunk)) { match = i; break; }
  }
  if (match === -1) {
    for (let i = 0; i <= content.length; i++) {
      if (hunkMatches(content, i, hunk)) { match = i; break; }
    }
  }
  if (match === -1) return null;

  let consumed = 0;
  const inserted: string[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith("+")) inserted.push(line.slice(1));
    else if (line.startsWith("-")) consumed++;
    else {
      consumed++;
      inserted.push(line.startsWith(" ") ? line.slice(1) : line);
    }
  }

  const result = [...content];
  result.splice(match, consumed, ...inserted);
  return result;
}

function buildAddedFile(hunks: Hunk[]): string {
  const lines: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) lines.push(line.slice(1));
      else if (!line.startsWith("-")) lines.push(line.startsWith(" ") ? line.slice(1) : line);
    }
  }
  return lines.join("\n");
}

function clipVisualLine(line: string): string {
  return line.length > MAX_VISUAL_LINE_CHARS
    ? line.slice(0, MAX_VISUAL_LINE_CHARS - 1) + "…"
    : line;
}

function formatPatchVisualDisplay(patch: string, fallback: string): string {
  let filePatches: FilePatch[];
  try { filePatches = parsePatch(patch); }
  catch { return fallback; }
  if (filePatches.length === 0) return fallback;

  const lines: string[] = [];
  let shownFiles = 0;
  let shownDiffLines = 0;
  let skippedFiles = 0;
  let skippedDiffLines = 0;

  for (const fp of filePatches) {
    if (shownFiles >= MAX_VISUAL_FILES) { skippedFiles++; continue; }

    const fileLines: string[] = [];
    for (const hunk of fp.hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const rawLine of hunk.lines) {
        if (rawLine.startsWith("-")) {
          const text = clipVisualLine(rawLine.slice(1));
          fileLines.push(chalk.red(`- ${String(oldLine).padStart(3)} ${text}`));
          oldLine++;
        } else if (rawLine.startsWith("+")) {
          const text = clipVisualLine(rawLine.slice(1));
          fileLines.push(chalk.green(`+ ${String(newLine).padStart(3)} ${text}`));
          newLine++;
        } else {
          oldLine++;
          newLine++;
        }
      }
    }

    if (fileLines.length === 0) continue;
    shownFiles++;
    if (lines.length > 0) lines.push("");
    lines.push(chalk.bold(fp.newPath) + chalk.dim(` — ${fp.mode === "add" ? "Added" : "Updated"}`));

    for (const diffLine of fileLines) {
      if (shownDiffLines >= MAX_VISUAL_DIFF_LINES) {
        skippedDiffLines++;
        continue;
      }
      lines.push(diffLine);
      shownDiffLines++;
    }
  }

  if (skippedFiles > 0 || skippedDiffLines > 0) {
    lines.push(chalk.dim(`... ${skippedFiles} more file(s) / ${skippedDiffLines} more diff line(s) truncated`));
  }

  return lines.length > 0 ? lines.join("\n") : fallback;
}

export default {
  name: "apply_patch",
  condition: (ctx) => getOperationLevel(ctx) !== "read-only",
  /** Only visible when the provider attempt model starts with "gpt" (case-insensitive). */
  modelFilter: (model: string) => /^gpt/i.test(model),
  description:
    "Apply a *** Begin Patch text patch to the workspace. " +
    "Supports Add File and Update File across one or more text files. " +
    "All hunks are validated before any file is written; if validation fails, no files are changed. " +
    "Delete File is intentionally unsupported — use shell rm for explicit deletions.",
  guidance:
    "**apply_patch**: Use for GPT-optimized structured text patches. " +
    "Format patches as unified diff within *** Begin Patch / *** End Patch blocks. " +
    "Supports Add File and Update File only; use shell rm for deletions. " +
    "For small single-file edits, prefer edit_file or multi_edit.",
  input_schema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Patch text. Use *** Begin Patch / *** End Patch with unified diff file blocks: " +
          "--- a/path, +++ b/path, and @@ -line,count +line,count @@ hunks. " +
          "Delete File (/dev/null as new path) is not supported.",
      },
    },
    required: ["patch"],
  },
  serial: true,

  async execute(args, ctx): Promise<ToolOutput> {
    let filePatches: FilePatch[];
    try {
      filePatches = parsePatch(String(args.patch));
    } catch (err: any) {
      return `Error: failed to parse patch — ${err?.message ?? String(err)}`;
    }
    if (filePatches.length === 0) return "Error: no valid file patches found.";

    const plan: PlannedWrite[] = [];

    for (const fp of filePatches) {
      if (fp.mode === "delete") {
        return `Error: Delete File is not supported by apply_patch (${fp.oldPath}). Use shell rm for explicit deletions. No changes applied.`;
      }
      if (fp.hunks.length === 0) return `Error: ${fp.newPath} has no hunks. No changes applied.`;

      const absPath = ctx.fs.resolve(fp.newPath);
      if (!canWritePath(absPath, ctx)) {
        return `Error: permission denied for ${fp.newPath}. No changes applied.`;
      }

      if (fp.mode === "add") {
        if (await ctx.fs.exists(absPath)) {
          return `Error: cannot add ${fp.newPath} — file already exists. No changes applied.`;
        }
        plan.push({ absPath, result: buildAddedFile(fp.hunks), mode: "add" });
        continue;
      }

      const fileStat = await ctx.fs.stat(absPath);
      if (!fileStat) return `Error: ${fp.newPath} not found. No changes applied.`;
      if (fileStat.size > MAX_FILE_SIZE) {
        return `Error: ${fp.newPath} too large (${(fileStat.size / 1024 / 1024).toFixed(0)} MB, limit 1 GiB). No changes applied.`;
      }
      const staleMsg = await checkStaleness(absPath, ctx.fs);
      if (staleMsg) return `${staleMsg} No changes applied.`;

      const content = await ctx.fs.readText(absPath);
      let lines = content.split("\n");
      for (const hunk of fp.hunks) {
        const applied = applyHunk(lines, hunk);
        if (!applied) return `Error: failed to apply hunk in ${fp.newPath}. No changes applied.`;
        lines = applied;
      }
      plan.push({ absPath, result: lines.join("\n"), mode: "update" });
    }

    const results: string[] = [];
    for (const p of plan) {
      try {
        await ctx.fs.writeText(p.absPath, p.result);
      } catch (err: any) {
        return `Error: failed to write ${p.absPath} — ${err?.message ?? String(err)}. Earlier planned writes may already be applied.`;
      }
      clearFileRead(p.absPath, undefined, p.result, ctx.fs);
      results.push(`${p.mode === "add" ? "Added" : "Updated"} ${p.absPath}`);
    }

    return results.join("\n");
  },

  compactResult(_args, result) {
    return result;
  },
  formatDisplay(args, result) {
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error")) return res;
    return formatPatchVisualDisplay(String(args.patch ?? ""), res);
  },
} satisfies ToolDefinition;
