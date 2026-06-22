/**
 * memory_get — Read a memory file by path (relative to homes/{id}/).
 *
 * Supports optional line range and can attach wikilink graph data (links/backlinks)
 * via the SQLite index built by index-manager.
 * Only allows access to MEMORY.md and memories/ — no path traversal outside homes/{id}/.
 */

import { join, normalize, relative, isAbsolute } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { getMemoryIndexManager } from "#src/memory/index-manager.js";

// ─── Path safety ───────────────────────────────────────────────────────────────

function validateMemoryPath(homeDir: string, requestedPath: string): string | null {
  const normalized = normalize(requestedPath.replace(/^[/\\]+/, ""));
  if (isAbsolute(normalized)) return null;

  const absTarget = join(homeDir, normalized);
  const rel = relative(homeDir, absTarget);

  if (rel.startsWith("..")) return null;
  if (rel !== "MEMORY.md" && !rel.startsWith("memories/") && !rel.startsWith("memories\\")) {
    return null;
  }
  return rel;
}

// ─── Tool definition ───────────────────────────────────────────────────────────

export default {
  name: "memory_get",
  description:
    "Read a memory file by path (relative to homes/{id}/). " +
    "Allowed paths: MEMORY.md and anything under memories/. " +
    "Supports optional line range (startLine/numLines) for large files. " +
    "Set withLinks=true to attach wikilink backlinks and forward links from the SQLite index.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Relative path from homes/{id}/, e.g. 'MEMORY.md', 'memories/knowledge/topic.md', 'memories/daily/2026-03-16.md'",
      },
      startLine: {
        type: "integer",
        description: "Line number to start reading from (1-indexed). Negative counts from end.",
      },
      numLines: {
        type: "integer",
        description: "Number of lines to read from startLine.",
      },
      withLinks: {
        type: "boolean",
        description:
          "Attach backlinks and forward links for this file from the SQLite wikilink index. Default: false",
      },
    },
    required: ["path"],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const rawPath = String(args.path ?? "").trim();
    if (!rawPath) return "Error: path is required.";

    const homeDir = ctx.pathManager.team().homeFor(ctx.agentId);
    if (!getSandboxFs().existsSync(homeDir)) {
      return `Error: homes/ directory does not exist for agent '${ctx.agentId}'.`;
    }

    const relPath = validateMemoryPath(homeDir, rawPath);
    if (!relPath) {
      return `Error: path '${rawPath}' is not allowed. Only MEMORY.md and memories/ are accessible.`;
    }

    const absPath = join(homeDir, relPath);
    const startLine = args.startLine as number | undefined;
    const numLines = args.numLines as number | undefined;
    const withLinks = args.withLinks === true;

    // ─── File not found ────────────────────────────────────────────────────────

    if (!getSandboxFs().existsSync(absPath)) {
      const result: Record<string, unknown> = {
        path: relPath,
        exists: false,
        text: "",
      };
      if (withLinks) {
        result.links = [];
        result.backlinks = [];
      }
      return JSON.stringify(result, null, 2);
    }

    // ─── Read content ──────────────────────────────────────────────────────────

    let text: string;
    let totalLines: number;
    let actualStart: number;
    let actualEnd: number;

    try {
      const raw = getSandboxFs().readTextSync(absPath);
      const lines = raw.split("\n");
      totalLines = lines.length;

      if (startLine !== undefined && startLine < 0) {
        actualStart = Math.max(0, totalLines + startLine);
      } else if (startLine !== undefined) {
        actualStart = Math.max(0, startLine - 1);
      } else {
        actualStart = 0;
      }

      actualEnd = numLines !== undefined ? Math.min(totalLines, actualStart + numLines) : totalLines;
      text = lines.slice(actualStart, actualEnd).join("\n");
    } catch (err: unknown) {
      return `Error: failed to read ${relPath} — ${err instanceof Error ? err.message : String(err)}`;
    }

    // ─── Result ────────────────────────────────────────────────────────────────

    const isPartial = actualStart > 0 || actualEnd < totalLines;
    const result: Record<string, unknown> = {
      path: relPath,
      exists: true,
      text,
      totalLines,
      ...(isPartial ? { lineRange: [actualStart + 1, actualEnd] } : {}),
    };

    if (withLinks) {
      try {
        const manager = getMemoryIndexManager(homeDir);
        await manager.ensureIndex();
        const { links, backlinks } = manager.getLinks(relPath);
        result.links = links;
        result.backlinks = backlinks;
        if (links.length === 0 && backlinks.length === 0) {
          result.linksNote =
            "no links found — index may not have processed this file yet; try memory_search first to trigger indexing";
        }
      } catch (err: unknown) {
        result.links = [];
        result.backlinks = [];
        result.linksError = `links index unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return JSON.stringify(result, null, 2);
  },
  serial: false,
} satisfies ToolDefinition;
