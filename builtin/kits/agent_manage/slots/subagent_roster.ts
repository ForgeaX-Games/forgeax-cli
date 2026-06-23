/** subagent_roster — tells the LLM which teammates exist and how to call them.
 *
 *  Without this slot the agent has no clue mochi/rin/iro/… are even an
 *  option — and even if the user types "delegate to mochi" it'll grep the
 *  filesystem looking for a file. The slot lists two pools:
 *
 *   1. Active in this session — already scaffolded under <sid>/agents/, can
 *      receive a `delegate_to_subagent` call right now.
 *   2. Available to spawn — discovered from the plugin registry +
 *      marketplace manifest; first delegate call auto-scaffolds them.
 *
 *  Self is filtered out (an agent never appears in its own roster).
 *  cacheHint=dynamic because the active set changes as the user spawns
 *  new tabs across the session.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { listAgents } from "../../../../src/agents/loader";
import { getPluginSnapshot } from "../../../../src/plugins/registry";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import { readUninstalledAgentIds } from "../../../../src/api/lib/agent-prefs";
import { pickI18n } from "@forgeax/types";

interface RosterRow {
  id: string;
  displayName: string;
  role: string;
  description: string;
  active: boolean;
}

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

interface MarketplaceAgent {
  id: string;
  role?: string;
  displayName?: { zh?: string; en?: string };
  description?: { zh?: string; en?: string };
  card?: { name?: { zh?: string; en?: string } };
}

function readMarketplaceAgents(): MarketplaceAgent[] {
  const mp = findMarketplaceRoot();
  if (!mp) return [];
  const path = join(mp, "manifest.json");
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { agents?: MarketplaceAgent[] };
    return parsed.agents ?? [];
  } catch {
    return [];
  }
}

export function buildRoster(ctx: AgentContext): RosterRow[] {
  const selfId = ctx.agentPath.split("/").pop() ?? "";
  const seen = new Set<string>();
  const rows: RosterRow[] = [];

  // 1) Active sub-agents under this session — anything in the tree that
  //    isn't us and isn't an ancestor of us. We list siblings + nephews
  //    + descendants alike: from a parent's POV, a delegated child counts
  //    as a teammate, and from a child's POV a sibling does too.
  const activeIds = new Set<string>();
  for (const node of ctx.tree.list()) {
    if (node.path === ctx.agentPath) continue;
    const id = node.path.split("/").pop() ?? "";
    if (!id || id === selfId) continue;
    activeIds.add(id);
  }

  // Uninstalled set —— 用户从 Settings → Agents 主动勾掉的 agent id。已经在
  // 树里跑着的 active agent 即便被勾掉也保留可见（用户已经派过去了，藏掉会
  // 让 LLM 看不到自己刚 delegate 的 teammate）；只过滤「Available to spawn」。
  const uninstalled = new Set(readUninstalledAgentIds());

  // Surface each plugin agent's manifest `description` (i18n) keyed by plugin
  // id. Without this the roster listed plugin agents with an EMPTY description,
  // so the orchestrator routed by keyword-guessing the id/role alone — e.g.
  // "影游动画" got delegated to `animator-2d` (saw 动画) instead of `reia` (the
  // 影游/FMV director). The manifest description is the agent's own SSOT for
  // "what I am / when to delegate to me" (16-AGENT-PACK-SPEC §3.3), so it
  // belongs in the dispatch roster.
  const descByPluginId = new Map<string, string>();
  for (const m of getPluginSnapshot().manifests) {
    const rawDesc = (m.manifest as { description?: unknown }).description;
    if (!rawDesc) continue;
    const d = pickI18n(rawDesc as Parameters<typeof pickI18n>[0], "zh");
    if (d) descByPluginId.set(m.manifest.id, d.length > 260 ? `${d.slice(0, 257)}…` : d);
  }

  // 2) Plugin agents (marketplace plugins under packages/marketplace/plugins).
  for (const entry of listAgents()) {
    const id = entry.definition.id;
    if (id === selfId || seen.has(id)) continue;
    if (uninstalled.has(id) && !activeIds.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      displayName: pickI18n(entry.definition.card.name, "zh") || id,
      role: entry.definition.role,
      description: descByPluginId.get(entry.pluginId) ?? "",
      active: activeIds.has(id),
    });
  }

  // 3) Legacy marketplace.json peers (kotone, iro, tsumugi, cc-coder, forge,
  //    iori, suzu) — registered via marketplace manifest, not yet a plugin.
  for (const a of readMarketplaceAgents()) {
    const id = a.id;
    if (!id || id === selfId || seen.has(id)) continue;
    if (uninstalled.has(id) && !activeIds.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      displayName: a.card?.name?.zh ?? a.displayName?.zh ?? a.displayName?.en ?? id,
      role: a.role ?? "peer",
      description: a.description?.zh ?? a.description?.en ?? "",
      active: activeIds.has(id),
    });
  }

  // 4) Active in tree but not registered anywhere (rare — a hand-scaffolded
  //    agent dir). Surface so delegation still works.
  for (const id of activeIds) {
    if (seen.has(id)) continue;
    rows.push({ id, displayName: id, role: "(unregistered)", description: "", active: true });
  }

  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return rows;
}

function renderRoster(rows: RosterRow[]): string {
  if (rows.length === 0) {
    return "# Teammates\n\n_(no other agents registered in this workspace)_";
  }
  const active = rows.filter((r) => r.active);
  const available = rows.filter((r) => !r.active);
  const lines: string[] = [];
  lines.push("# Teammates");
  lines.push("");
  lines.push(
    "You can delegate work to other agents in this session via the " +
      "`delegate_to_subagent` tool. Each teammate has their own persona, " +
      "skills, tools, memory, and chat tab — your message lands in their " +
      "inbox and the user reads their reply by switching tabs. Use this " +
      "instead of greping the filesystem when the user says \"ask X to …\" " +
      "or \"let X handle this\".",
  );
  lines.push("");
  if (active.length > 0) {
    lines.push("## Active in this session");
    for (const r of active) {
      const desc = r.description ? ` — ${r.description}` : "";
      lines.push(`- **${r.id}** (${r.displayName}, ${r.role})${desc}`);
    }
    lines.push("");
  }
  if (available.length > 0) {
    lines.push("## Available to spawn (auto-scaffolded on first delegate)");
    for (const r of available) {
      const desc = r.description ? ` — ${r.description}` : "";
      lines.push(`- **${r.id}** (${r.displayName}, ${r.role})${desc}`);
    }
    lines.push("");
  }
  lines.push(
    "Call `list_subagents` for a fresh snapshot if you suspect the roster " +
      "changed mid-session.",
  );
  return lines.join("\n");
}

export default function subagentRosterSlot(ctx: AgentContext): ContextSlot {
  return {
    name: "subagent_roster",
    description:
      "Names of teammate agents (active + available to spawn) plus the " +
      "delegate_to_subagent contract. Without this the LLM has no idea " +
      "mochi / rin / etc. are anything other than filenames to grep for.",
    priority: SlotPriority.DYNAMIC_SUBAGENTS,
    cacheHint: "dynamic",
    version: 1,
    content: () => renderRoster(buildRoster(ctx)),
  };
}
