// @desc Dynamic slot — renders MEMORY.md head (≤200 lines) + knowledge/experience file index
import { join, basename } from "node:path";
import { getSandboxFs, type SandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory, ContextSlot } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";

const MEMORY_HEAD_LINES = 200;

/** Recursively list .md files under dir via fs-bridge sync API. Returns relative paths. */
function listMdFilesSync(fs: SandboxFs, dir: string, prefix = ""): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch { return results; }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const s = fs.statSync(full);
    if (!s) continue;
    if (s.isDirectory) {
      results.push(...listMdFilesSync(fs, full, rel));
    } else if (name.endsWith(".md")) {
      results.push(rel);
    }
  }
  return results;
}

function slugToLabel(filename: string): string {
  return basename(filename, ".md").replace(/-/g, " ");
}

function readHead(fs: SandboxFs, filePath: string, maxLines: number): [string, number, boolean] {
  let raw: string;
  try { raw = fs.readTextSync(filePath); }
  catch { return ["", 0, false]; }

  const allLines = raw.split("\n");
  const total = allLines.length;
  if (total <= maxLines) return [raw, total, false];
  return [allLines.slice(0, maxLines).join("\n"), total, true];
}

const create: SlotFactory = (ctx) => {
  const homeDir = ctx.pathManager.team().homeFor(ctx.agentId);
  const memoriesDir = join(homeDir, "memories");
  const memoryMdPath = join(homeDir, "MEMORY.md");

  const slot: ContextSlot = {
    name: "memory-index",
    priority: SlotPriority.DYNAMIC_CONTEXT,
    cacheHint: "dynamic",
    version: 0,

    content: () => {
      const fs = getSandboxFs();
      const sections: string[] = [];

      const [head, totalLines, truncated] = readHead(fs, memoryMdPath, MEMORY_HEAD_LINES);
      if (head) {
        sections.push("<core-memory>");
        sections.push(head);
        if (truncated) {
          sections.push(`\n<!-- MEMORY.md truncated at ${MEMORY_HEAD_LINES}/${totalLines} lines. Use memory_get(path="MEMORY.md", startLine=${MEMORY_HEAD_LINES + 1}) to read the rest. -->`);
        }
        sections.push("</core-memory>");
      }

      const knowledgeFiles = listMdFilesSync(fs, join(memoriesDir, "knowledge"));
      if (knowledgeFiles.length > 0) {
        sections.push("<knowledge-index>");
        for (const f of knowledgeFiles) {
          sections.push(`- ${slugToLabel(f)} → memory_get(path="memories/knowledge/${f}")`);
        }
        sections.push("</knowledge-index>");
      }

      return sections.join("\n");
    },
  };

  return slot;
};

export default create;
