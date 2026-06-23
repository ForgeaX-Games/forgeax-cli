// @desc Search the upstream skill marketplace by keyword to discover what methodologies are available.
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { DEFAULT_UPSTREAM, DEFAULT_UPSTREAM_BASE_PATH } from "../lib/skill-downloader.js";
import { getUpstreamIndex } from "../lib/skill-indexer.js";

export default {
  name: "search_skill",
  description:
    "Search Anthropic's upstream skill marketplace (github.com/anthropics/skills) " +
    "by keyword to discover which methodologies are available. Use this when you " +
    "need a methodology but aren't sure of the exact skill name, or want to " +
    "explore what's available in a domain (documents, APIs, design, testing, …). " +
    "Matching is case-insensitive substring against both skill name and " +
    "description. Omit `query` to browse all available skills. Each result " +
    "includes an `installed_team` / `installed_agent` flag so you know whether " +
    "to call `fetch_skill` next. Results are cached for 24h; pass `refresh: true` " +
    "to force re-download.",
  guidance:
    "**search_skill → fetch_skill**: pair these two. Search first when unsure of " +
    "the exact name — one call answers it. Don't guess names and retry " +
    "fetch_skill, and don't go browse the GitHub web UI when this tool exists.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Keyword or phrase to match against skill name + description. " +
          "Case-insensitive substring. Omit to list all available skills.",
      },
      refresh: {
        type: "boolean",
        description:
          "Force re-download the upstream tarball and rebuild the index. " +
          "Default: false (use 24h cache). Set true when suspecting the cache is stale.",
      },
    },
    required: [],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const forceRefresh = args.refresh === true;

    // Resolve upstream config from overrides.json (shared with skill_bootstrap + fetch_skill)
    const raw = ctx.getAgentJson()?.capabilities?.config?.skills?.skill_bootstrap as
      | Record<string, unknown>
      | undefined;
    const upstream = typeof raw?.upstream === "string" ? raw.upstream : DEFAULT_UPSTREAM;
    const upstreamBasePath =
      typeof raw?.upstreamBasePath === "string" ? raw.upstreamBasePath : DEFAULT_UPSTREAM_BASE_PATH;

    const isAborted = () => ctx.signal.aborted;
    const index = await getUpstreamIndex(ctx, upstream, upstreamBasePath, {
      forceRefresh,
      isAborted,
    });
    if (!index) {
      return `Error: failed to fetch or parse upstream index from ${upstream}. Network or tarball structure issue — check logs.`;
    }

    const teamSkillsDir = join(ctx.pathManager.team().root(), "skills");
    const agentSkillsDir = join(ctx.pathManager.agent(ctx.agentId).root(), "skills");

    const items = index.entries
      .filter((entry) => {
        if (!query) return true;
        const hay = `${entry.name} ${entry.description}`.toLowerCase();
        return hay.includes(query);
      })
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        ...(entry.license && { license: entry.license }),
        ...(entry.compatibility && { compatibility: entry.compatibility }),
        installed_team: getSandboxFs().existsSync(join(teamSkillsDir, entry.name, "SKILL.md")),
        installed_agent: getSandboxFs().existsSync(join(agentSkillsDir, entry.name, "SKILL.md")),
      }));

    const cachedAt = new Date(index.cachedAtMs).toISOString();
    const ageMin = Math.round((Date.now() - index.cachedAtMs) / 60_000);

    return JSON.stringify(
      {
        upstream: index.upstream,
        cached_at: cachedAt,
        cache_age_minutes: ageMin,
        total_upstream: index.entries.length,
        matched: items.length,
        ...(query && { query }),
        skills: items,
        hint:
          items.length === 0
            ? `No skill matches "${query}". Try a broader term, omit query to see all, or refresh=true.`
            : "Use fetch_skill(name, scope?) to install a selected skill. scope defaults to 'team'.",
      },
      null,
      2,
    );
  },

  formatDisplay(args, result) {
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error")) return res;
    try {
      const parsed = JSON.parse(res);
      const q = args.query ? ` "${args.query}"` : " (all)";
      return `search_skill${q} — ${parsed.matched}/${parsed.total_upstream} skill(s), cache ${parsed.cache_age_minutes}min old`;
    } catch {
      return "search_skill";
    }
  },
} satisfies ToolDefinition;
