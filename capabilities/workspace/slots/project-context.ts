// @desc Context-file slot — traverses CWD→instanceRoot collecting AGENTS.md/CLAUDE.md + directory tree
import { join, relative, resolve, dirname } from "node:path";
import { getSandboxFs, type SandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory, ContextSlot } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";

const MAX_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 50;
const HEAD_LINES = 20;
const TAIL_LINES = 10;

// AGENTS.md first: AgenTeam's own naming takes priority over CLAUDE.md (the reference agent CLI convention).
// In each directory, only the first found is used.
const DOC_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

// ── Directory tree ────────────────────────────────────────────────
function buildDirTree(
  fs: SandboxFs,
  dir: string,
  depth: number = 0,
  count = { n: 0 },
): string[] {
  if (depth > MAX_TREE_DEPTH || count.n >= MAX_TREE_ENTRIES) return [];

  const lines: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch { return lines; }

  const indent = "  ".repeat(depth);
  for (const name of entries) {
    if (count.n >= MAX_TREE_ENTRIES) {
      lines.push(`${indent}... (truncated)`);
      break;
    }
    if (name.startsWith(".") || name === "node_modules") continue;

    const full = join(dir, name);
    const s = fs.statSync(full);
    if (!s) continue;

    if (s.isDirectory) {
      lines.push(`${indent}${name}/`);
      count.n++;
      lines.push(...buildDirTree(fs, full, depth + 1, count));
    } else {
      lines.push(`${indent}${name}`);
      count.n++;
    }
  }
  return lines;
}

// ── Doc file helpers ──────────────────────────────────────────────

function readDocFile(fs: SandboxFs, dir: string): { name: string; content: string } | null {
  for (const name of DOC_NAMES) {
    try {
      const content = fs.readTextSync(join(dir, name));
      return { name, content };
    } catch { /* not found, try next */ }
  }
  return null;
}

function truncateDoc(content: string, fullPath: string): string {
  const lines = content.split("\n");
  if (lines.length <= HEAD_LINES + TAIL_LINES + 2) return content;

  const head = lines.slice(0, HEAD_LINES).join("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return `${head}\n... 省略 ${omitted} 行，完整内容见 ${fullPath}\n${tail}`;
}

// ── Traversal ─────────────────────────────────────────────────────

interface CollectedDoc {
  relDir: string;
  docName: string;
  content: string;
  absPath: string;
}

function collectDocs(fs: SandboxFs, cwd: string, instanceRoot: string): CollectedDoc[] {
  const docs: CollectedDoc[] = [];
  let current = resolve(cwd);
  const root = resolve(instanceRoot);
  const isOutside = !current.startsWith(root + "/") && current !== root;
  const visited = new Set<string>();

  while (true) {
    visited.add(current);
    const doc = readDocFile(fs, current);
    if (doc) {
      const relDir = isOutside && !current.startsWith(root)
        ? current
        : relative(root, current) || ".";
      docs.push({
        relDir,
        docName: doc.name,
        content: doc.content,
        absPath: join(current, doc.name),
      });
    }

    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (isOutside && !visited.has(root)) {
    const doc = readDocFile(fs, root);
    if (doc) {
      docs.push({
        relDir: ".",
        docName: doc.name,
        content: doc.content,
        absPath: join(root, doc.name),
      });
    }
  }

  return docs;
}

// ── Slot content builder ──────────────────────────────────────────

function buildContent(fs: SandboxFs, cwd: string, instanceRoot: string): string {
  const root = resolve(instanceRoot);
  const resolvedCwd = resolve(cwd);

  const isOutside = !resolvedCwd.startsWith(root + "/") && resolvedCwd !== root;
  const relCwd = isOutside ? resolvedCwd : (relative(root, resolvedCwd) || ".");

  const parts: string[] = [];
  parts.push(`## CWD: ${relCwd}`);

  const tree = buildDirTree(fs, resolvedCwd);
  if (tree.length > 0) {
    parts.push(`\n### Directory Structure\n\`\`\`\n${tree.join("\n")}\n\`\`\``);
  }

  const docs = collectDocs(fs, resolvedCwd, root);
  if (docs.length === 0) return parts.join("\n");

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const source = doc.relDir === "." ? doc.docName : `${doc.relDir}/${doc.docName}`;

    if (i === 0) {
      parts.push(`\n### ${doc.docName} (from ${doc.relDir}/)\n${doc.content}`);
    } else {
      const truncated = truncateDoc(doc.content, source);
      parts.push(`\n### ${doc.docName} (from ${doc.relDir}/)\n${truncated}`);
    }
  }

  return parts.join("\n");
}

// ── Slot definition ───────────────────────────────────────────────

const create: SlotFactory = (ctx): ContextSlot => {
  const { agentId, teamBoard, pathManager } = ctx;
  const instanceRoot = resolve(pathManager.instance().root());

  return {
    name: "project-context",
    priority: SlotPriority.DYNAMIC_CONTEXT,
    cacheHint: "dynamic",
    version: 0,
    content: () => {
      const dir = teamBoard.get(agentId, TEAMBOARD_KEYS.CURRENT_DIR) as string | undefined;
      const cwd = dir || instanceRoot;
      return buildContent(getSandboxFs(), cwd, instanceRoot);
    },
  };
};

export default create;
