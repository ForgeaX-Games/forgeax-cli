import type { ToolDefinition, AgentContext } from "#src/core/types.js";
import { readToolKeys, getKey, missingKeyMessage } from "#src/fs/tool-keys.js";

const SEARCH_TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function readTavilyKey(ctx: AgentContext): Promise<{ key: string; fileExists: boolean }> {
  const result = await readToolKeys(ctx.pathManager);
  const key = getKey(result, "tavily") ?? "";
  return { key, fileExists: result.fileExists };
}

async function tavilySearch(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Tavily API ${res.status}`);

  const data = (await res.json()) as {
    results: { title: string; url: string; content: string }[];
  };
  return data.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

async function ddgSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: { "User-Agent": "AgenTeam-OS/1.0" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);

  const html = await res.text();
  const results: SearchResult[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < maxResults) {
    results.push({
      title: strip(m[2]),
      url: decodeURIComponent(m[1].replace(/.*uddg=/, "").replace(/&.*/, "")),
      snippet: strip(m[3]),
    });
  }
  return results;
}

function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export default {
  name: "web_search",
  description:
    "Search the web and return titles, URLs, and snippets. " +
    "Uses Tavily API when configured (key/tools.json), falls back to DuckDuckGo.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: {
        type: "number",
        description: "Maximum number of results (default: 5)",
      },
    },
    required: ["query"],
  },
  requiredKeys: [
    { key: "tavily", description: "Tavily Search API key (for web_search tool)" },
  ],
  compactResult(args) {
    return `[web_search query="${args.query}"]`;
  },
  async execute(args, ctx) {
    const query = String(args.query);
    const rawMax = args.max_results ?? 5;
    const maxResults = Number.isFinite(Number(rawMax)) ? Number(rawMax) : 5;

    const { key: tavilyKey, fileExists } = await readTavilyKey(ctx);

    if (tavilyKey) {
      try {
        return JSON.stringify({ source: "tavily", results: await tavilySearch(query, maxResults, tavilyKey) });
      } catch (e) {
        return JSON.stringify({
          note: `Tavily 请求失败（${(e as Error).message}），已降级使用 DuckDuckGo，结果质量较低。`,
          source: "duckduckgo",
          results: await ddgSearch(query, maxResults).catch((de) => {
            throw new Error(`Tavily: ${(e as Error).message}; DuckDuckGo: ${(de as Error).message}`);
          }),
        });
      }
    }

    try {
      const note = fileExists
        ? "tavily 字段未配置，已降级使用 DuckDuckGo。如需高质量搜索请在宿主机 ~/.agenteam/key/tools.json 中添加 tavily 字段。"
        : "宿主机 ~/.agenteam/key/tools.json 不可读，已降级使用 DuckDuckGo。请在宿主机上创建该文件并添加 tavily 字段。";
      return JSON.stringify({
        note,
        source: "duckduckgo",
        results: await ddgSearch(query, maxResults),
      });
    } catch (e) {
      return JSON.stringify({
        error: `搜索失败：DuckDuckGo 不可用（${(e as Error).message}）。\n${missingKeyMessage("tavily", "启用 Tavily 高质量搜索", fileExists)}`,
      });
    }
  },
  serial: false,
} satisfies ToolDefinition;
