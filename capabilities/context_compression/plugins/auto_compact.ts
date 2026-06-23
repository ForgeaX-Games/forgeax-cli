/** @desc Auto-compaction plugin — monitors LLM usage and compacts immediately when threshold crossed (turn-internal safe) */

import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { getModelSpec } from "#src/llm/provider.js";
import { compactCurrentSession } from "#src/context-window/summary-compaction.js";

const MAX_CONSECUTIVE_FAILURES = 3;

export default function create(ctx: AgentContext): PluginSource {
  const config = ctx.getAgentJson().capabilities?.config?.context_compression as Record<string, unknown> | undefined;
  const threshold = (config?.threshold as number | undefined) ?? 0.85;

  let unsubUsage: (() => void) | null = null;
  let compacting = false;
  let consecutiveFailures = 0;

  function emitStatusMessage(content: string): void {
    ctx.eventBus.publish({
      source: "plugin:auto_compact",
      type: "compaction_status",
      payload: { content },
      ts: Date.now(),
    });
  }

  /**
   * Resolve a model name to look up the context window. Falls back through:
   * assistant message's own model → agent.json → global agenteam.json.
   */
  function resolveModelName(llmMsgModel: string | undefined): string | undefined {
    if (llmMsgModel) return llmMsgModel;
    try {
      const m = ctx.getAgentJson().models?.model;
      if (m) return Array.isArray(m) ? m[0] : m;
    } catch { /* ignore */ }
    try {
      const global = JSON.parse(getSandboxFs().readTextSync(ctx.pathManager.shared().agenteamConfig())) as
        { models?: { model?: string | string[] } };
      const m = global.models?.model;
      if (m) return Array.isArray(m) ? m[0] : m;
    } catch { /* ignore */ }
    return undefined;
  }

  async function runCompaction(totalTokens: number, contextWindow: number, utilization: number): Promise<void> {
    if (compacting) return;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    if (!ctx.ledger) return;

    compacting = true;
    try {
      const result = await compactCurrentSession({
        agentId: ctx.agentId,
        ledger: ctx.ledger,
        eventBus: ctx.eventBus,
        getAgentJson: ctx.getAgentJson,
        signal: ctx.signal,
      });

      if (!result.ok) {
        consecutiveFailures++;
        console.warn(`auto_compact skipped: ${result.reason} (failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        emitStatusMessage(`[auto_compact] 已跳过自动压缩：${result.reason}`);
        return;
      }

      consecutiveFailures = 0;
      console.log(
        `auto_compact (partial) done | msgs: ${result.originalMessageCount} → ${result.newMessageCount}` +
        ` | armed at ${(utilization * 100).toFixed(1)}% (${totalTokens}/${contextWindow})` +
        (result.summarizeUsage ? ` | summary output: ${result.summarizeUsage.outputTokens}` : ""),
      );
      emitStatusMessage(
        `[auto_compact] 增量分段压缩完成，` +
        `消息 ${result.originalMessageCount} -> ${result.newMessageCount}。`,
      );
    } catch (err: unknown) {
      consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`auto_compact failed: ${msg} (failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      emitStatusMessage(`[auto_compact] 自动压缩失败：${msg}`);
    } finally {
      compacting = false;
    }
  }

  return {
    name: "auto_compact",

    start() {
      // Trigger compaction immediately when an AssistantMessage's usage crosses
      // the threshold. partialCompact's cutoff anchors on user-role messages,
      // so mid-turn split is safe — no need to wait for hook:TurnEnd anymore.
      unsubUsage = ctx.eventBus.observe((event, emitterId) => {
        if (emitterId !== ctx.agentId) return;
        if (event.type !== ctx.hook.AssistantMessage) return;
        if (compacting) return;

        const payload = event.payload as Record<string, unknown>;
        const usage = payload.usage as { inputTokens: number; outputTokens: number } | undefined;
        if (!usage) return;

        const totalTokens = usage.inputTokens + usage.outputTokens;
        if (totalTokens <= 0) return;

        const modelName = resolveModelName(payload.model as string | undefined);
        if (!modelName) return;

        const contextWindow = getModelSpec(modelName).contextWindow;
        if (!contextWindow || contextWindow <= 0) return;

        const utilization = totalTokens / contextWindow;
        if (utilization > threshold) {
          void runCompaction(totalTokens, contextWindow, utilization);
        }
      });
    },

    stop() {
      unsubUsage?.();
      unsubUsage = null;
    },
  };
}
