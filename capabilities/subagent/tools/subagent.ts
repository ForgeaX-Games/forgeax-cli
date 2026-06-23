/** @desc subagent — launch scheduler-managed anonymous subagents */

import type {
  AgentContext,
  TeamBoardAPI,
  ToolDefinition,
  ToolOutput,
} from "#src/core/types.js";
import { getInstanceScheduler } from "#src/core/scheduler.js";
import type { Scheduler } from "#src/core/scheduler.js";
import type { AgentTree } from "#src/tree/agent-tree.js";
import {
  isSubagentType,
  RECURSION_RULES,
  resolveSubagentMode,
} from "../lib/defaults.js";
import { sleep } from "#src/utils.js";
import { resolveTemplateMeta, resolveTemplatePath } from "#src/team/agent-scaffold.js";
import { buildInitialPrompt } from "../lib/context.js";
import {
  waitForSubagentCompletion,
  monitorBackgroundSubagent,
  type SubagentOutcome,
} from "../lib/monitor.js";
import type { ContextMode, SubagentMode, SubagentType } from "../lib/types.js";
import { isAbsolute, resolve } from "node:path";
import { runExternalSubAgent } from "../lib/external-provider.js";
import { readFileSync, statSync } from "node:fs";

// Lifecycle note: the parent does NOT maintain any subagent list.
// finalizeSubagent does the full cycle: shutdown (via scheduler) then
// tree.free + teamboard wipe. Scheduler itself only clears memory.

// ─── Tool definition ────────────────────────────────────────────────────────

export default {
  name: "subagent",
  description:
    "Delegate a self-contained subtask to a disposable subagent. Frees your context window for higher-level reasoning.\n\n" +
    "Available types:\n" +
    "- observe: Read-only exploration — code search, file reading, fact-finding\n" +
    "- plan: Read-only research + structured plan generation\n" +
    "- act: Full read/write execution — code changes, file creation, config updates\n" +
    "- review: Code/plan review with principle-based framework (read-only, no sub-spawning)\n" +
    "- Custom templates: use list_templates to discover project-specific types\n\n" +
    "When NOT to use:\n" +
    "- Reading a known file path → read_file directly\n" +
    "- Simple text search → grep/glob directly\n" +
    "- Quick question to the user → just ask\n" +
    "- Task you haven't understood yet → understand first, then delegate\n\n" +
    "Writing the task prompt:\n" +
    "Brief the subagent like a colleague who just walked in — no conversation history, no shared context.\n" +
    "Include: (1) what to accomplish and why, (2) what you've already learned or ruled out, " +
    "(3) relevant file paths or code locations, (4) scope boundaries — what's in, what's out.\n" +
    "Never delegate understanding — if you can't specify file paths and concrete changes, you haven't understood the problem yet. " +
    "Don't write 'based on your findings, fix it'; write exactly what to fix, where, and how.\n\n" +
    "Mode: background returns immediately (parallel work); foreground awaits result (sequential dependency).\n" +
    "Context: none (default, subagent starts fresh); summary (recent conversation excerpt); full (extended conversation history).\n" +
    "Subagents can ask questions — foreground returns status=question, reply via subagent_reply(to=subagentId).",
  guidance:
    "**subagent**: Proactively delegate. If a subtask can be described in a sentence, hand it off. " +
    "observe for any code lookup / fact-finding; plan for design work; act for implementation; review for quality checks. " +
    "Multiple subagents can run in parallel via background mode. " +
    "When writing task: be specific — include file paths, explain why, state what's in/out of scope. " +
    "Never delegate understanding: if you can't name the file and the fix, research more before delegating. " +
    "When a foreground subagent returns status=question, answer with subagent_reply(to=subagentId, content=...). " +
    "The subagent will continue and its final result arrives as a background event.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task for the subagent to perform. " +
          "Structure: what to do + why + known context + file paths + scope boundaries. " +
          "Use absolute paths when possible. Be specific enough that a colleague with no prior context can execute.",
      },
      type: {
        type: "string",
        description: "Built-in types: observe (read-only exploration), plan (read-only planning), act (full modification). " +
          "Use list_templates to discover additional templates — any template name can be used here. " +
          "Common templates also include: review (principle-based code/plan review).",
      },
      mode: {
        type: "string",
        enum: ["background", "foreground"],
        description: "background: return immediately; foreground: await result. Defaults depend on subagent type.",
      },
      context: {
        type: "string",
        enum: ["none", "summary", "full"],
        description: "How much parent context to pass during launch (default: none)",
      },
      cwd: {
        type: "string",
        description: "Working directory for the subagent. Absolute path or relative to parent's current directory. " +
          "Sets CURRENT_DIR so all file tools resolve relative paths from here. Omit to use the subagent's default (its home dir).",
      },
    },
    required: ["task", "type"],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const scheduler = getInstanceScheduler();
    if (!scheduler) return JSON.stringify({ error: "Scheduler not running." });
    const tree = scheduler.getAgentTree();
    if (!tree) return JSON.stringify({ error: "AgentTree not available." });
    return await launchSubagent(args, ctx, scheduler, tree);
  },

  compactResult(_args, result) {
    return result;
  },
  formatDisplay(_args, result) {
    try {
      const parsed = JSON.parse(String(result)) as Record<string, unknown>;
      if (parsed.error) return `error: ${String(parsed.error).slice(0, 200)}`;
      if (parsed.status === "question") return `question: ${String(parsed.question ?? "").slice(0, 200)}`;
      if (parsed.status === "launched") return `${parsed.subagentId} launched (background)`;
      let text = String(parsed.result ?? "");
      if (text.startsWith("[{")) {
        try {
          const arr = JSON.parse(text) as Array<{ type: string; text?: string }>;
          text = arr.filter(p => p.type === "text" && p.text).map(p => p.text).join("\n");
        } catch { /* use as-is */ }
      }
      return text || `${parsed.status ?? "done"}`;
    } catch {
      return String(result).slice(0, 300);
    }
  },
  serial: false,
} satisfies ToolDefinition;

// ─── Launch ─────────────────────────────────────────────────────────────────

async function launchSubagent(
  args: Record<string, unknown>,
  ctx: AgentContext,
  scheduler: Scheduler,
  tree: AgentTree,
): Promise<ToolOutput> {
  const task = String(args.task ?? "").trim();
  const typeRaw = String(args.type ?? "").trim();
  const contextModeRaw = String(args.context ?? "none").trim();

  if (!task) return JSON.stringify({ error: "task is required" });
  if (!typeRaw) return JSON.stringify({ error: "type is required" });
  if (!isContextMode(contextModeRaw)) return JSON.stringify({ error: `Invalid context mode: ${contextModeRaw}` });

  const type = typeRaw;
  const modeRaw = args.mode ? String(args.mode) : undefined;
  const mode: SubagentMode = modeRaw === "background" ? "background"
    : modeRaw === "foreground" ? "foreground"
    : isSubagentType(type) ? resolveSubagentMode(type)!
    : "foreground";

  const parentType = detectParentType(ctx.teamBoard, ctx.agentId);
  if (parentType !== null) {
    const allowed = RECURSION_RULES[parentType];
    if (isSubagentType(type) ? !allowed.includes(type) : allowed.length === 0) {
      return JSON.stringify({ error: `Recursion limit: ${parentType} cannot spawn ${type}` });
    }
  }

  // ─── Multi-cli bridge (Phase 5 of forgeax-studio's cli-providers design) ────
  // If the team manifest declares this subagent type with provider != "forgeax",
  // delegate the run to the studio server (which routes via ClaudeCodeProvider,
  // CodexProvider, etc.) instead of spawning a local cli child. Events are
  // forwarded onto the parent's EventBus by external-provider.ts so the
  // studio UI renders them in a normal SubAgentCard with a provider badge.
  const externalProvider = lookupSubagentProvider(type, ctx);
  if (externalProvider && externalProvider !== "forgeax") {
    const subAgentId = `${type}-${Date.now().toString(36)}`;
    const parentInstanceId = process.env.FORGEAX_INSTANCE_ID ?? "(unknown)";
    const result = await runExternalSubAgent({
      subAgentId,
      parentInstanceId,
      task,
      bus: ctx.eventBus,
      signal: ctx.signal,
    });
    if (result.ok) {
      return JSON.stringify({
        status: "completed",
        subagentId: subAgentId,
        provider: externalProvider,
        result: result.text,
        stopReason: result.stopReason,
      });
    }
    return JSON.stringify({
      status: "failed",
      subagentId: subAgentId,
      provider: externalProvider,
      error: result.error ?? `external provider returned stopReason=${result.stopReason}`,
    });
  }

  // Validate template exists BEFORE reserving subagent id. Without this check,
  // tree.create() silently falls back to bare default scaffold when the template
  // is not found — the subagent then runs a generic LLM task and produces misleading
  // "completed" results. Fail fast so callers see "template not found" instead of
  // garbage outputs.
  const templatePath = resolveTemplatePath(type, ctx.agentId);
  if (templatePath === null) {
    return JSON.stringify({
      error: `Template "${type}" not found in any layer (agent-local → team → instance). ` +
        `Ensure a template directory exists at one of: ` +
        `agents/<parent>/templates/${type}, team/templates/${type}, or templates/${type}.`,
    });
  }

  const subagentId = generateSubagentId(type);
  const initialPrompt = await buildInitialPrompt(ctx, task, contextModeRaw);

  // Resolve template-driven opt-ins here (caller's responsibility).
  // agent-scaffold / agent-tree remain dumb — they just consume boolean flags.
  const templateMeta = resolveTemplateMeta(type, ctx.agentId);
  const inheritedRole = templateMeta.inheritRole
    ? tree.roleOf(ctx.agentId) ?? undefined
    : undefined;

  // Seed markers BEFORE tree.create so plugin conditions can see them when the
  // subagent initializes (plugin activation happens during the tree.create →
  // FSWatcher → initAgent chain — we must beat that timing).
  //
  // subagent_type is persistent so restarted stale subagents still load the
  // lifecycle plugin and can self-clean. subagent_runtime_owner is intentionally
  // volatile: it exists only for subagents launched in the current worker. If a
  // subagent starts with subagent_type but without runtime_owner, it survived a
  // worker boundary and must be treated as stale.
  ctx.teamBoard.set(subagentId, "subagent_type", type, { persist: true });
  ctx.teamBoard.set(subagentId, "subagent_runtime_owner", ctx.agentId, { persist: false });

  try {
    const createResult = await tree.create({
      id: subagentId,
      parentId: ctx.agentId,
      template: type,
      role: inheritedRole,
      emitterId: ctx.agentId,
      fillFromParent: templateMeta.fillFromParent,
      mergeParentAgentJson: templateMeta.mergeParentAgentJson,
    });
    if (!createResult.ok) throw new Error(createResult.error);

    await waitForAgentReady(scheduler, subagentId);

    // Override CURRENT_DIR if caller specified a cwd
    const rawCwd = args.cwd ? String(args.cwd).trim() : "";
    if (rawCwd) {
      const parentDir = String(ctx.teamBoard.get(ctx.agentId, "CURRENT_DIR") ?? "");
      const resolvedCwd = isAbsolute(rawCwd) ? rawCwd : resolve(parentDir, rawCwd);
      ctx.teamBoard.set(subagentId, "CURRENT_DIR", resolvedCwd, { persist: false });
    }

    dispatchSubagentPrompt(scheduler, subagentId, initialPrompt);
  } catch (err: any) {
    await finalizeSubagent(scheduler, subagentId);
    return JSON.stringify({ error: `Failed to launch subagent: ${err.message ?? String(err)}` });
  }

  ctx.eventBus.publish({
    source: "tool:subagent",
    type: "subagent_launched",
    payload: { subagentId, type, task },
    ts: Date.now(),
  });

  if (mode === "foreground") {
    const outcome = await waitForSubagentCompletion({ scheduler, subagentId, signal: ctx.signal });
    return handleForegroundOutcome(ctx, scheduler, subagentId, ctx.agentId, outcome);
  }

  monitorBackgroundSubagent({
    scheduler, subagentId, parentId: ctx.agentId, type,
    emitParentEvent: (event, emitterId) => ctx.eventBus.emit(event, emitterId),
    onComplete: () => { void finalizeSubagent(scheduler, subagentId); },
  });
  return JSON.stringify({ subagentId, status: "launched", type, mode: "background" });
}

// ─── Foreground result handling ─────────────────────────────────────────────

function handleForegroundOutcome(
  ctx: AgentContext,
  scheduler: Scheduler,
  subagentId: string,
  parentId: string,
  outcome: SubagentOutcome,
): ToolOutput {
  if (outcome.status === "question") {
    monitorBackgroundSubagent({
      scheduler, subagentId, parentId,
      type: (ctx.teamBoard.get(subagentId, "subagent_type") as string) ?? "act",
      emitParentEvent: (event, emitterId) => ctx.eventBus.emit(event, emitterId),
      onComplete: () => { void finalizeSubagent(scheduler, subagentId); },
    });
    return JSON.stringify({ subagentId, status: "question", question: outcome.question });
  }

  if (outcome.status === "completed") {
    ctx.eventBus.publish({
      source: "tool:subagent",
      type: "subagent_result",
      payload: { subagentId, content: outcome.result },
      ts: Date.now(),
    });
    void finalizeSubagent(scheduler, subagentId);
    return JSON.stringify({ subagentId, status: "completed", result: outcome.result });
  }

  ctx.eventBus.publish({
    source: "tool:subagent",
    type: "subagent_error",
    payload: { subagentId, error: outcome.error },
    ts: Date.now(),
  });
  void finalizeSubagent(scheduler, subagentId);
  return JSON.stringify({ subagentId, status: "error", error: outcome.error });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function detectParentType(teamBoard: TeamBoardAPI, agentId: string): SubagentType | null {
  const value = teamBoard.get(agentId, "subagent_type") as string | undefined;
  if (typeof value === "string" && isSubagentType(value)) return value;
  return null;
}

/** Read team/manifest.json#agents[type].provider from the parent agent's
 *  instance directory. Returns undefined when the manifest doesn't list
 *  `type` — caller treats that as "no override, run as a regular forgeax
 *  subagent". Cached by mtime so repeated calls in a long-running parent
 *  agent don't re-read on every dispatch. */
const _providerCache = new Map<string, { mtimeMs: number; provider?: string }>();
function lookupSubagentProvider(type: string, ctx: AgentContext): string | undefined {
  try {
    // ctx.agentDir is <instance>/team/agents/<id>/ — walk up to team/manifest.json
    const manifestPath = resolve(ctx.agentDir, "..", "..", "manifest.json");
    const st = statSync(manifestPath);
    const cached = _providerCache.get(manifestPath);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      // Refresh based on type
      return readProviderFor(manifestPath, type, st.mtimeMs);
    }
    return readProviderFor(manifestPath, type, st.mtimeMs);
  } catch {
    return undefined;
  }
}
function readProviderFor(manifestPath: string, type: string, mtimeMs: number): string | undefined {
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { agents?: Array<{ id?: string; provider?: string }> };
    const agent = parsed.agents?.find((a) => a.id === type);
    const provider = agent?.provider;
    _providerCache.set(manifestPath, { mtimeMs, provider });
    return provider;
  } catch {
    return undefined;
  }
}

function generateSubagentId(templateType: string): string {
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const label = templateType.replace(/[^a-zA-Z0-9_-]/g, "_") || "agent";
  return `subagent_${label}_${uid}`;
}

async function waitForAgentReady(
  scheduler: Scheduler,
  agentId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!scheduler.getAgent(agentId)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Agent '${agentId}' did not start within ${timeoutMs}ms`);
    }
    await sleep(50);
  }
}

/** Full subagent teardown via controlAgent("remove"). */
async function finalizeSubagent(
  scheduler: Scheduler,
  subagentId: string,
): Promise<void> {
  await scheduler.controlAgent("remove", subagentId).catch(() => {});
}

function dispatchSubagentPrompt(
  scheduler: Scheduler,
  subagentId: string,
  prompt: string,
): void {
  scheduler.eventBus.emit({
    source: "tool:subagent",
    type: "subagent_task",
    to: subagentId,
    payload: { content: prompt },
    ts: Date.now(),
    priority: 0,
  });
}

function isContextMode(value: string): value is ContextMode {
  return value === "none" || value === "summary" || value === "full";
}
