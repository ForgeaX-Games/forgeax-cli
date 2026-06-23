/** Provider smoke test — exercise every (keySection, model) pair from the
 *  fixture llm_key.json with a single-turn prompt and write a markdown report.
 *
 *  Usage: bun packages/server/test/llm/providers-smoke.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { initPathManager, getPathManager } from "../../src/fs/path-manager.js";
import "../../src/llm/register-all.js";
import { createProvider } from "../../src/llm/provider.js";
import { assembleResponseWithCallback } from "../../src/llm/stream.js";
import { formatLLMError } from "../../src/llm/errors.js";
import type { LLMMessage, SystemBlock } from "../../src/llm/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_USER_DIR = resolve(HERE, "..", "fixtures", "user-dir");
const REPORTS = resolve(HERE, "..", "reports");

initPathManager({ userRoot: FIXTURE_USER_DIR });

interface KeyEntry {
  api_key: string;
  api: string;
  api_base?: string;
  auth_type?: string;
  models: string[];
}

interface Result {
  section: string;
  model: string;
  api: string;
  ok: boolean;
  latencyMs: number;
  text?: string;
  thinking?: string;
  inputTokens?: number;
  outputTokens?: number;
  truncated?: boolean;
  error?: string;
}

const TEST_PROMPT = "请用一句话告诉我你是哪个模型，并报上你能记起的版本号。回答控制在 30 字以内。";
const MAX_PER_CALL_MS = 60_000;

async function runOne(section: string, model: string, api: string): Promise<Result> {
  const t0 = Date.now();
  const baseResult: Omit<Result, "ok" | "latencyMs"> = { section, model, api };

  try {
    const provider = createProvider({
      model: `${model}@${section}`,
      temperature: 0.3,
      maxTokens: 256,
      maxRetries: 0,
    });

    const system: SystemBlock[] = [
      { name: "smoke-test", text: "You are an LLM under integration test.", cacheHint: "stable", priority: 0 },
    ];
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: TEST_PROMPT }], ts: Date.now() },
    ];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("test timeout")), MAX_PER_CALL_MS);
    try {
      const stream = provider.chatStream(system, messages, [], ctrl.signal);
      const response = await assembleResponseWithCallback(stream);
      const text = typeof response.content === "string"
        ? response.content
        : response.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
      return {
        ...baseResult,
        ok: true,
        latencyMs: Date.now() - t0,
        text: text.trim(),
        thinking: response.thinking?.trim() || undefined,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        truncated: response.truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      ...baseResult,
      ok: false,
      latencyMs: Date.now() - t0,
      error: formatLLMError(err),
    };
  }
}

function trim(text: string | undefined, n: number): string {
  if (!text) return "";
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function tokensCell(r: Result): string {
  if (r.inputTokens == null && r.outputTokens == null) return "—";
  return `${r.inputTokens ?? "—"}/${r.outputTokens ?? "—"}`;
}

function escMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function buildReport(results: Result[]): string {
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const ts = new Date().toISOString();
  const grouped = new Map<string, Result[]>();
  for (const r of results) {
    if (!grouped.has(r.section)) grouped.set(r.section, []);
    grouped.get(r.section)!.push(r);
  }

  const lines: string[] = [];
  lines.push(`# LLM Provider Smoke Test Report`);
  lines.push("");
  lines.push(`- Generated: ${ts}`);
  lines.push(`- Prompt: \`${TEST_PROMPT}\``);
  lines.push(`- Total calls: ${results.length}`);
  lines.push(`- Pass: ${okCount}`);
  lines.push(`- Fail: ${failCount}`);
  lines.push("");

  lines.push("## Summary by key section");
  lines.push("");
  lines.push("| section | api | models | pass | fail |");
  lines.push("|---|---|---:|---:|---:|");
  for (const [section, rs] of grouped) {
    const api = rs[0]?.api ?? "—";
    const pass = rs.filter((r) => r.ok).length;
    const fail = rs.length - pass;
    lines.push(`| ${section} | ${api} | ${rs.length} | ${pass} | ${fail} |`);
  }
  lines.push("");

  lines.push("## Detailed results");
  for (const [section, rs] of grouped) {
    lines.push("");
    lines.push(`### \`${section}\` (${rs[0]?.api ?? "?"})`);
    lines.push("");
    lines.push("| model | ok | latency | tokens (in/out) | reply / error |");
    lines.push("|---|:-:|---:|---:|---|");
    for (const r of rs) {
      const status = r.ok ? "✅" : "❌";
      const reply = r.ok
        ? trim(r.text, 140) + (r.thinking ? `  *(thinking: ${trim(r.thinking, 60)})*` : "")
        : `**ERR:** ${trim(r.error, 200)}`;
      lines.push(`| \`${r.model}\` | ${status} | ${r.latencyMs}ms | ${tokensCell(r)} | ${escMd(reply)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  await mkdir(REPORTS, { recursive: true });
  const keysPath = getPathManager().user().llmKeyFile();
  const keys: Record<string, KeyEntry> = JSON.parse(await readFile(keysPath, "utf-8"));

  const tasks: Array<{ section: string; model: string; api: string; hasKey: boolean }> = [];
  for (const [section, entry] of Object.entries(keys)) {
    for (const model of entry.models) {
      tasks.push({ section, model, api: entry.api, hasKey: Boolean(entry.api_key) });
    }
  }

  console.log(`▶ smoke-test plan: ${tasks.length} (section, model) pairs across ${Object.keys(keys).length} sections`);
  for (const t of tasks) {
    process.stdout.write(`  · ${t.section}/${t.model} … `);
    if (!t.hasKey) {
      console.log("SKIP (no api_key)");
      continue;
    }
  }

  const results: Result[] = [];
  for (const t of tasks) {
    if (!t.hasKey) {
      results.push({
        section: t.section,
        model: t.model,
        api: t.api,
        ok: false,
        latencyMs: 0,
        error: "skipped: empty api_key in fixture",
      });
      continue;
    }
    process.stdout.write(`▶ ${t.section}/${t.model} `);
    const r = await runOne(t.section, t.model, t.api);
    results.push(r);
    process.stdout.write(r.ok ? `OK ${r.latencyMs}ms\n` : `FAIL ${r.latencyMs}ms — ${trim(r.error, 80)}\n`);
  }

  const report = buildReport(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = resolve(REPORTS, `llm-smoke-${stamp}.md`);
  await writeFile(outPath, report, "utf-8");
  console.log("");
  console.log(`✓ report written: ${outPath}`);

  const failed = results.filter((r) => !r.ok && r.error !== "skipped: empty api_key in fixture").length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
