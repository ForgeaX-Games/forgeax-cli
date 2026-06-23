/** file_activity_recent — surfaces recent file mutations across all agents
 *  in this session so an LLM can see "who just touched what" without polling
 *  the filesystem or asking via tool calls.
 *
 *  Why this slot exists
 *  --------------------
 *  Without it, agent A has no idea agent B just rewrote `src/main.ts` two
 *  turns ago. Two failure modes follow: (1) A re-reads / overwrites B's
 *  work, racing on stale content; (2) when the user asks "what did the
 *  team do today" A grovels through `produces[]` static manifest entries
 *  that have nothing to do with reality. The activity ledger
 *  (`<sid>/file-activity.jsonl`) is the SSOT for actual mutations. This
 *  slot reads the last N entries and renders them as a short markdown
 *  block so every agent in the session shares the same picture.
 *
 *  cacheHint='dynamic' because every write extends the ledger; we want
 *  fresh content on every prompt build.
 *
 *  Self-attribution: we DO include this agent's own writes — that
 *  reinforces "yes you really did write this file three turns ago, no
 *  need to do it again". Filtering self would have us forget our own
 *  recent work, which is the opposite of useful. */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import type { FileActivityRecord } from "../../../../src/ledger/file-activity-ledger";

const MAX_ENTRIES = 12;
/** Hard cap so a 5MB ledger doesn't blow up the prompt — we only ever need
 *  the tail. 64KB tail comfortably covers the latest few hundred records. */
const TAIL_BYTES = 64 * 1024;

function readTail(ledgerPath: string): FileActivityRecord[] {
  if (!existsSync(ledgerPath)) return [];
  let st: ReturnType<typeof statSync>;
  try { st = statSync(ledgerPath); } catch { return []; }
  if (st.size === 0) return [];
  const startByte = Math.max(0, st.size - TAIL_BYTES);
  let text: string;
  try {
    text = readFileSync(ledgerPath, "utf-8");
    if (startByte > 0) text = text.slice(text.indexOf("\n", startByte) + 1);
  } catch { return []; }
  const out: FileActivityRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line) as FileActivityRecord); } catch { /* skip */ }
  }
  return out;
}

function formatRelTime(now: number, ts: number): string {
  const dms = now - ts;
  // Use coarse buckets (5-min resolution) so the text stays identical across
  // consecutive prompt builds and diffSystemBlocks won't emit spurious carriers.
  if (dms < 300_000) return "just now";
  if (dms < 3_600_000) return `${Math.floor(dms / 300_000) * 5}m ago`;
  if (dms < 86_400_000) return `${Math.floor(dms / 3_600_000)}h ago`;
  return `${Math.floor(dms / 86_400_000)}d ago`;
}

function shorten(absPath: string, sessionRoot: string, gameRoot: string | undefined): string {
  if (gameRoot && absPath.startsWith(gameRoot + "/")) return absPath.slice(gameRoot.length + 1);
  if (absPath.startsWith(sessionRoot + "/")) return "<session>/" + absPath.slice(sessionRoot.length + 1);
  return absPath;
}

function renderActivity(records: FileActivityRecord[], ctx: AgentContext): string {
  if (records.length === 0) {
    return [
      "# Recent file activity (this session)",
      "",
      "_(no file mutations recorded yet — this section will fill in as you and your teammates write)_",
    ].join("\n");
  }
  const sessionRoot = ctx.pathManager.session(ctx.tree.sid).root();
  // ctx.cwd is the resolved game root when defaultDir is set; otherwise = agentDir.
  // Either way it gives a useful relative anchor for the listing.
  const gameRoot = ctx.cwd && ctx.cwd !== ctx.agentDir ? ctx.cwd : undefined;
  const now = Date.now();
  const lines: string[] = [];
  lines.push("# Recent file activity (this session)");
  lines.push("");
  lines.push(
    "Below is the live ledger of file mutations across every agent in this " +
      "session. SSOT: derived from `<sid>/file-activity.jsonl`, written by " +
      "every successful `ctx.fs.*` mutation. Use it instead of guessing from " +
      "static `produces[]` manifests — those describe intent, this is fact.",
  );
  lines.push("");
  lines.push("| when | agent | op | bytes | path |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const rec of records.slice(0, MAX_ENTRIES)) {
    const when = formatRelTime(now, rec.ts);
    const agent = rec.agentPath === ctx.agentPath ? `**${rec.agentPath}** (you)` : rec.agentPath;
    const path = shorten(rec.path, sessionRoot, gameRoot);
    const opMark = rec.op === "write" && rec.isCreate ? "create" : rec.op;
    const bytes = rec.bytes != null ? String(rec.bytes) : "—";
    lines.push(`| ${when} | ${agent} | ${opMark} | ${bytes} | \`${path}\` |`);
  }
  if (records.length > MAX_ENTRIES) {
    lines.push("");
    lines.push(`_(showing latest ${MAX_ENTRIES} of ${records.length} tail entries — call \`list_file_activity\` for full query)_`);
  }
  return lines.join("\n");
}

/** Slot factory. ConsciousAgent runs this on every prompt assembly when
 *  cacheHint=dynamic — read cost = one statSync + 64KB tail read. Cheap. */
export default function fileActivityRecentSlot(ctx: AgentContext): ContextSlot {
  return {
    name: "file_activity_recent",
    description:
      "Recent file mutations recorded across all agents in this session " +
      "(SSOT: <sid>/file-activity.jsonl). Lets the LLM see what its " +
      "teammates have actually written without grepping or guessing from " +
      "produces[] manifests.",
    priority: SlotPriority.DYNAMIC_SUBAGENTS,
    cacheHint: "dynamic",
    version: 1,
    content: () => {
      const ledgerPath = ctx.pathManager.session(ctx.tree.sid).fileActivityLog();
      // Read newest-first, scoped to this session's ledger.
      const records = readTail(ledgerPath).reverse();
      return renderActivity(records, ctx);
    },
  };
}
