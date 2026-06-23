// @desc GPT-oriented apply_patch — validated text patch writer for Add/Update file edits
import { displayChalk as chalk } from "../lib/display-chalk";
import type { ToolDefinition, ToolOutput } from "../../../../src/core/types";
import { canWritePath } from "../lib/file-write-permissions";
import { checkStaleness, clearFileRead } from "../lib/file-state";
import { getOperationLevel } from "../condition";

const MAX_FILE_SIZE = 1024 * 1024 * 1024;
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

const FILE_HEADER_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const FORMAT_HINT =
  'Use Codex format inside *** Begin Patch / *** End Patch:\n' +
  '  *** Update File: path/to/file\n' +
  '  @@\n' +
  '   context line\n' +
  '  -removed\n' +
  '  +added\n' +
  '  *** Add File: path/to/new   (then "+" lines only)';

function parsePatch(raw: string): FilePatch[] {
  const lines = raw.split(/\r?\n/);
  const begin = lines.indexOf("*** Begin Patch");
  const end = lines.lastIndexOf("*** End Patch");
  if (begin === -1 || end === -1 || begin >= end) throw new Error("Patch envelope missing. " + FORMAT_HINT);

  const block = lines.slice(begin + 1, end);
  if (block.some((l) => l.startsWith("--- ") || l.startsWith("+++ "))) {
    throw new Error('Unified-diff ("--- a/path" / "+++ b/path") not supported. ' + FORMAT_HINT);
  }

  const files: FilePatch[] = [];
  let i = 0;
  while (i < block.length) {
    const m = block[i].match(FILE_HEADER_RE);
    if (!m) { i++; continue; }

    const op = m[1].toLowerCase() as "add" | "update" | "delete";
    const path = normalizePatchPath(m[2]);
    i++;

    if (op === "delete") { files.push({ oldPath: path, newPath: path, mode: "delete", hunks: [] }); continue; }

    if (op === "add") {
      const added: string[] = [];
      while (i < block.length && !FILE_HEADER_RE.test(block[i])) {
        if (block[i].startsWith("+")) added.push(block[i]);
        i++;
      }
      files.push({
        oldPath: path, newPath: path, mode: "add",
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: added.length, lines: added }],
      });
      continue;
    }

    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    while (i < block.length && !FILE_HEADER_RE.test(block[i])) {
      const l = block[i];
      if (l.startsWith("@@")) {
        if (cur && cur.lines.length) hunks.push(cur);
        cur = { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines: [] };
      } else {
        if (!cur) cur = { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines: [] };
        if (l === "" || l.startsWith(" ") || l.startsWith("+") || l.startsWith("-")) {
          cur.lines.push(l === "" ? " " : l);
        }
      }
      i++;
    }
    if (cur && cur.lines.length) hunks.push(cur);
    files.push({ oldPath: path, newPath: path, mode: "update", hunks });
  }

  if (files.length === 0) throw new Error("No *** Add/Update/Delete File: blocks found. " + FORMAT_HINT);
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
    else { consumed++; inserted.push(line.startsWith(" ") ? line.slice(1) : line); }
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
          fileLines.push(chalk.red(`- ${String(oldLine).padStart(3)} ${clipVisualLine(rawLine.slice(1))}`));
          oldLine++;
        } else if (rawLine.startsWith("+")) {
          fileLines.push(chalk.green(`+ ${String(newLine).padStart(3)} ${clipVisualLine(rawLine.slice(1))}`));
          newLine++;
        } else { oldLine++; newLine++; }
      }
    }
    if (fileLines.length === 0) continue;
    shownFiles++;
    if (lines.length > 0) lines.push("");
    lines.push(chalk.bold(fp.newPath) + chalk.dim(` — ${fp.mode === "add" ? "Added" : "Updated"}`));
    for (const diffLine of fileLines) {
      if (shownDiffLines >= MAX_VISUAL_DIFF_LINES) { skippedDiffLines++; continue; }
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
  modelFilter: (model: string) => /^gpt/i.test(model),
  description:
    "Apply a Codex-format *** Begin Patch text patch (Add File / Update File). " +
    "All hunks validated before any write; on failure nothing is changed. " +
    "Delete File unsupported — use shell rm.",
  guidance:
    "**apply_patch**: Codex-format only. " + FORMAT_HINT + "\n" +
    "Paths are workspace-relative. Hunks are matched by surrounding context (no line numbers); include enough context to be unique.",
  input_schema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          'Codex-format patch wrapped in *** Begin Patch / *** End Patch. ' +
          'File blocks: "*** Add File: <path>" or "*** Update File: <path>". ' +
          'Update hunks use "@@" headers with " "/"-"/"+" lines.',
      },
    },
    required: ["patch"],
  },
  serial: true,

  async execute(args, ctx): Promise<ToolOutput> {
    let filePatches: FilePatch[];
    try { filePatches = parsePatch(String(args.patch)); }
    catch (err: any) { return `Error: failed to parse patch — ${err?.message ?? String(err)}`; }
    if (filePatches.length === 0) return "Error: no *** Add/Update/Delete File: blocks found. " + FORMAT_HINT;

    const plan: PlannedWrite[] = [];

    for (const fp of filePatches) {
      if (fp.mode === "delete") {
        return `Error: Delete File is not supported by apply_patch (${fp.oldPath}). Use shell rm for explicit deletions. No changes applied.`;
      }
      if (fp.hunks.length === 0) return `Error: ${fp.newPath} has no hunks. No changes applied.`;

      const absPath = ctx.fs.resolve(fp.newPath);
      if (!canWritePath(absPath, ctx)) return `Error: permission denied for ${fp.newPath}. No changes applied.`;

      if (fp.mode === "add") {
        if (await ctx.fs.exists(absPath)) return `Error: cannot add ${fp.newPath} — file already exists. No changes applied.`;
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
        if (!applied) {
          return `Error: hunk context not found in ${fp.newPath} ` +
            "(check whitespace/indentation; file may have changed since last read). No changes applied.";
        }
        lines = applied;
      }
      plan.push({ absPath, result: lines.join("\n"), mode: "update" });
    }

    const results: string[] = [];
    // If the agent's fs is wrapped by the file-activity recorder, tag patched
    // files with op:"patch" so the ledger distinguishes hunk applies from
    // full-overwrite writes. Falls back to writeText (op:"write") in test
    // harnesses where no recorder is attached.
    const fsAny = ctx.fs as { recordedWrite?: (p: string, c: string, op: "patch") => Promise<void> };
    for (const p of plan) {
      try {
        if (typeof fsAny.recordedWrite === "function") {
          await fsAny.recordedWrite(p.absPath, p.result, "patch");
        } else {
          await ctx.fs.writeText(p.absPath, p.result);
        }
      }
      catch (err: any) {
        return `Error: failed to write ${p.absPath} — ${err?.message ?? String(err)}. Earlier planned writes may already be applied.`;
      }
      clearFileRead(p.absPath, undefined, p.result, ctx.fs);
      results.push(`${p.mode === "add" ? "Added" : "Updated"} ${p.absPath}`);
    }
    return results.join("\n");
  },

  compactResult(_args, result) { return result; },
  formatDisplay(args, result) {
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error")) return res;
    return formatPatchVisualDisplay(String(args.patch ?? ""), res);
  },
} satisfies ToolDefinition;
