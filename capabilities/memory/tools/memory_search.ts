/**
 * memory_search — Search the current agent's memory files.
 *
 * Supports four scopes (MEMORY, knowledge, daily, experience) and three modes
 * (auto, fts, semantic). Optionally attaches wikilink graph data (backlinks/links)
 * via the SQLite index built by index-manager.
 */

import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { ToolDefinition, ToolOutput, AgentContext } from "#src/core/types.js";
import { readToolKeys, getKey } from "#src/fs/tool-keys.js";
import {
  getMemoryIndexManager,
  type MemorySource,
  type SearchResult,
} from "#src/memory/index-manager.js";
import { buildEmbeddingProvider } from "#src/memory/embedding.js";

// ─── Valid gemini_output_dim values ───────────────────────────────────────────

const VALID_GEMINI_DIMS = [256, 512, 768, 1024, 1536, 3072] as const;
type GeminiOutputDim = typeof VALID_GEMINI_DIMS[number];

function isValidGeminiDim(v: number): v is GeminiOutputDim {
  return (VALID_GEMINI_DIMS as readonly number[]).includes(v);
}

// ─── Key + config loading ─────────────────────────────────────────────────────

/** Read embedding API keys from key/tools.json. */
async function readEmbeddingKeys(
  ctx: AgentContext,
): Promise<{ gemini: string; openai: string }> {
  const result = await readToolKeys(ctx.pathManager);
  return {
    gemini: getKey(result, "memory_gemini") ?? "",
    openai: getKey(result, "memory_openai") ?? "",
  };
}

/**
 * Read optional non-sensitive embedding config from agenteam.json.
 * Only gemini_output_dim is read here; API keys are in key/tools.json.
 */
async function readEmbeddingConfig(
  configPath: string,
): Promise<{ geminiOutputDim: GeminiOutputDim }> {
  try {
    const raw = getSandboxFs().readTextSync(configPath);
    const json = JSON.parse(raw) as { tools?: { memory_search?: { gemini_output_dim?: number } } };
    const dim = json.tools?.memory_search?.gemini_output_dim;
    if (dim !== undefined && isValidGeminiDim(dim)) return { geminiOutputDim: dim };
  } catch { /* missing or invalid — use defaults */ }
  return { geminiOutputDim: 768 };
}

async function resolveEmbeddingProvider(ctx: AgentContext) {
  const { gemini, openai } = await readEmbeddingKeys(ctx);
  if (!gemini && !openai) return null;
  const { geminiOutputDim } = await readEmbeddingConfig(ctx.pathManager.shared().agenteamConfig());
  return buildEmbeddingProvider(gemini, openai, geminiOutputDim);
}

// ─── Source selection ──────────────────────────────────────────────────────────

function parseScopesToSources(scope: string): MemorySource[] {
  switch (scope) {
    case "MEMORY":     return ["MEMORY"];
    case "knowledge":  return ["knowledge"];
    case "daily":      return ["daily"];
    case "experience": return ["experience"];
    default:           return ["MEMORY", "knowledge", "daily", "experience"];
  }
}

// ─── Tool definition ───────────────────────────────────────────────────────────

export default {
  name: "memory_search",
  requiredKeys: [
    { key: "memory_gemini", description: "Google Gemini API key (for memory semantic search)" },
    { key: "memory_openai", description: "OpenAI API key (for memory semantic search, alternative)" },
  ],
  description:
    "Search or browse this agent's memory files (homes/{id}/MEMORY.md and homes/{id}/memories/). " +
    "When query is provided: keyword (FTS) and/or semantic search. " +
    "When query is omitted: returns the most recently modified memories (by file mtime), " +
    "useful for catching up on recent context after waking up or resuming a session. " +
    "Scopes: MEMORY (long-term facts), knowledge (linked knowledge graph), " +
    "daily (day-level logs), experience (error/fix triples). " +
    "Set followLinks=true to attach wikilink backlinks/links from the SQLite graph index.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search query — keywords, error codes, or natural language phrase. " +
          "Optional: when omitted or empty, switches to recency mode and returns " +
          "the most recently modified memory files sorted by mtime descending.",
      },
      scope: {
        type: "string",
        enum: ["all", "MEMORY", "knowledge", "daily", "experience"],
        description: "Which memory layer(s) to search. Default: all",
      },
      mode: {
        type: "string",
        enum: ["auto", "fts", "semantic"],
        description:
          "Search mode. auto = FTS + Embedding hybrid (when embedding key configured). " +
          "fts = keyword only. semantic = embedding only (requires memory_gemini or memory_openai in key/tools.json).",
      },
      maxResults: {
        type: "integer",
        description: "Maximum results to return. Default: 8",
      },
      temporalDecay: {
        type: "boolean",
        description: "Apply time-based score decay to daily results (recent files rank higher). Default: true",
      },
      followLinks: {
        type: "boolean",
        description:
          "Attach backlinks and forward links to each knowledge/experience result from the SQLite wikilink index. Default: false",
      },
    },
    required: [],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const query = String(args.query ?? "").trim();

    const scope = String(args.scope ?? "all");
    const mode = String(args.mode ?? "auto");
    const maxResults = Math.min(Number(args.maxResults ?? 8), 50);
    const temporalDecay = args.temporalDecay !== false;
    const followLinks = args.followLinks === true;

    const homeDir = ctx.pathManager.team().homeFor(ctx.agentId);
    if (!getSandboxFs().existsSync(homeDir)) {
      return "Memory not initialized: homes/ directory does not exist.";
    }

    const memMd = join(homeDir, "MEMORY.md");
    const memoriesDir = join(homeDir, "memories");
    if (!getSandboxFs().existsSync(memMd) && !getSandboxFs().existsSync(memoriesDir)) {
      return "No memory files found. Create MEMORY.md or memories/ in your homes/ directory to get started.";
    }

    const embeddingProvider = await resolveEmbeddingProvider(ctx);
    const manager = getMemoryIndexManager(homeDir, embeddingProvider ?? undefined);

    try {
      await manager.ensureIndex();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Memory index unavailable (better-sqlite3 not installed): ${msg}\n\nTo enable memory_search, run: npm run team -- load <pack-id>`;
    }

    // mode=semantic requires an embedding provider — fail early with a clear message
    if (mode === "semantic" && !embeddingProvider) {
      return JSON.stringify({
        error: "Semantic search is not available: no embedding API key configured.",
        action: "Add memory_gemini or memory_openai to ~/.agenteam/key/tools.json (on the host machine) to enable semantic search.",
        fallback: "Use mode=fts for keyword search, or mode=auto to use FTS when no key is present.",
      });
    }

    const sources = parseScopesToSources(scope);
    let results: SearchResult[] = [];
    let semanticSkipped = false;

    if (!query) {
      results = manager.getRecent(sources, maxResults);
      if (results.length === 0) {
        return `No memories found in scope "${scope}".`;
      }
      if (followLinks) {
        for (const result of results) {
          if (result.source !== "knowledge" && result.source !== "experience") continue;
          const { links, backlinks } = manager.getLinks(result.path);
          if (links.length > 0) result.links = links;
          if (backlinks.length > 0) result.backlinks = backlinks;
        }
      }
      return JSON.stringify({ mode: "recent", results }, null, 2);
    }

    if (mode === "fts" || mode === "auto") {
      const ftsDecay = temporalDecay && sources.includes("daily");
      results = await manager.searchFts(query, sources, maxResults * 2, ftsDecay);
    }

    if (mode === "semantic" || (mode === "auto" && embeddingProvider)) {
      const semanticResults = await manager.searchSemantic(query, sources, maxResults);
      if (mode === "semantic") {
        results = semanticResults;
      } else if (semanticResults.length > 0) {
        results = manager.mergeResults(results, semanticResults, maxResults * 2);
      }
    } else if (mode === "auto" && !embeddingProvider) {
      semanticSkipped = true;
    }

    if (scope === "all") {
      const priorityWeight: Record<MemorySource, number> = {
        MEMORY: 1.5, knowledge: 1.2, experience: 1.0, daily: 0.8,
      };
      results = results.map((r) => ({ ...r, score: r.score * (priorityWeight[r.source] ?? 1.0) }));
    }

    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, maxResults);

    if (results.length === 0) {
      const note = semanticSkipped
        ? " (semantic search skipped — configure memory_gemini or memory_openai in ~/.agenteam/key/tools.json on the host machine to enable)"
        : "";
      return `No results found for query "${query}" in scope "${scope}".${note}`;
    }

    if (followLinks) {
      for (const result of results) {
        if (result.source !== "knowledge" && result.source !== "experience") continue;
        const { links, backlinks } = manager.getLinks(result.path);
        if (links.length > 0) result.links = links;
        if (backlinks.length > 0) result.backlinks = backlinks;
      }
    }

    const output: Record<string, unknown> = { results };
    if (semanticSkipped) {
      output.note = "Semantic search skipped (no embedding key configured). Results are FTS-only. Configure memory_gemini or memory_openai in ~/.agenteam/key/tools.json (on the host machine) to enable hybrid search.";
    }
    return JSON.stringify(output, null, 2);
  },
} satisfies ToolDefinition;
