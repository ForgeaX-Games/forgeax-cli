/** memory slot —— 把 agent.json::memoryDir 目录下的 *.md 注入 prompt。
 *
 *  设计要点：
 *   - sub-agent 在 sessions API auto-scaffold / delegate_to_subagent 时
 *     会从 plugin manifest 把 memoryDir 写到 `<sid>/agents/<path>/agent.json`。
 *     这里只读 agent.json，不再回过去查 plugin registry —— 与 persona slot
 *     保持对称。
 *   - 路径解析顺序：绝对路径 → projectRoot 相对 →（兜底）marketplace 根相对，
 *     和 persona 完全一致；marketplace 根 fallback 让旧 manifest 里 `./memory/`
 *     这种相对项也能解到。
 *   - 目录里所有 *.md 文件按文件名排序拼成一个 SystemBlock；每段以 `## <basename>`
 *     起头，方便 LLM 在引用记忆时点出来源。空目录 / 读不到 → 静默返回空串。
 *   - cacheHint='stable' + STATIC_CORE：长期记忆和 persona 同档，理应进 stable
 *     段保留 LLM prompt-cache 命中。文件改动 → readFileSync 拿到新内容 → 因为
 *     content 是闭包（每轮 prompt 重组），下一轮自然刷新；不需要 fs.watch。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";

function findMarketplaceRoot(): string | null {
  const root = defaultProjectRoot();
  const candidates = [
    resolve(root, "packages/marketplace"),
    resolve(root, "../packages/marketplace"),
    resolve(root, "../../packages/marketplace"),
    resolve(root, "marketplace"),
    resolve(root, "../marketplace"),
  ];
  return candidates.find((p) => existsSync(join(p, "manifest.json"))) ?? null;
}

function resolveMemoryDir(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return existsSync(trimmed) ? trimmed : null;
  const projectAbs = resolve(defaultProjectRoot(), trimmed);
  if (existsSync(projectAbs)) return projectAbs;
  const mp = findMarketplaceRoot();
  if (mp) {
    const mpAbs = resolve(mp, trimmed);
    if (existsSync(mpAbs)) return mpAbs;
  }
  return null;
}

function loadMemoryFiles(absDir: string): Array<{ file: string; body: string }> {
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir);
  } catch {
    return [];
  }
  const mds = entries.filter((f) => f.toLowerCase().endsWith(".md")).sort();
  const out: Array<{ file: string; body: string }> = [];
  for (const f of mds) {
    try {
      const body = readFileSync(join(absDir, f), "utf-8").trim();
      if (body) out.push({ file: f, body });
    } catch {
      // unreadable file → skip silently; warning channel here would be noisy
      // (slot runs every turn). The author can verify via observatory's
      // resolved-prompt view if memory is missing.
    }
  }
  return out;
}

export default function memorySlot(_ctx: AgentContext): ContextSlot | null {
  return {
    name: "memory",
    description:
      "Inject the agent's long-term memory: every *.md under " +
      "agent.json::memoryDir, concatenated as `## <file>\\n<body>`. Empty / " +
      "unresolved dir → empty content, slot is effectively skipped.",
    priority: SlotPriority.STATIC_CORE,
    cacheHint: "stable",
    version: 1,
    content: () => {
      const aj = _ctx.getAgentJson();
      const raw = (aj.memoryDir ?? "").trim();
      if (!raw) return "";
      const abs = resolveMemoryDir(raw);
      if (!abs) return "";
      const files = loadMemoryFiles(abs);
      if (files.length === 0) return "";
      const blocks = files.map((m) => `## ${m.file}\n\n${m.body}`).join("\n\n");
      return `# Long-term Memory\n\n${blocks}`;
    },
    condition: (ctx) => {
      const raw = (ctx.getAgentJson().memoryDir ?? "").trim();
      return raw.length > 0;
    },
  };
}
