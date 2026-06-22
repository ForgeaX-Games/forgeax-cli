// @desc Auto-daily plugin — summarize recent work into daily/ memory files via LLM

import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";
import type { StoredEvent } from "#src/context-window/system-snapshot.js";
import { ConsciousAgent } from "#src/core/conscious-agent.js";
import { createProvider } from "#src/llm/provider.js";
import { assembleResponse } from "#src/llm/stream.js";
import { Hook } from "#src/hooks/types.js";

const TEAMBOARD_KEY = "daily:watermark";



const SUMMARIZE_PROMPT = `You are a factual work-log recorder for an AI agent. Given raw session events, produce a concise daily log entry.

<focus>
1. Goals: what was the agent trying to accomplish?
2. Outcomes: what was actually achieved? (files created, PRs submitted, bugs fixed, plans written)
3. Facts: key decisions made, important context discovered, user preferences expressed
4. Skills: if a multi-step methodology (skill) was used, was execution smooth or bumpy? Record the skill name and whether it worked well — smooth execution = ✅, required retries/corrections = ⚠️, failed = ❌
</focus>

<skip>
- Heartbeat/system ticks, routine status checks
- Individual tool calls — summarize the workflow outcome instead
- Repetitive sequences — batch into one line
</skip>

<constraints>
- Markdown bullet list, under 300 words
- Match the conversation's primary language
- No date/time headers — caller handles that
- Facts only — no opinions
</constraints>`;

interface DailyWatermark {
  lastSummarizedTs: number;
}

interface AutoDailyConfig {
  toolCallThreshold?: number;
  maxEventsPerSummary?: number;
  enabled?: boolean;
}

function getConfig(ctx: AgentContext): AutoDailyConfig {
  const raw = ctx.getAgentJson().capabilities?.config?.memory;
  return (raw && typeof raw === "object" ? raw : {}) as AutoDailyConfig;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Event types to skip entirely. */
const SKIP_TYPES = new Set(["hook:toolCall:pending", "hook:systemPrompt", "agent_log"]);

/** Payload keys that are noise for daily summaries. */
const NOISE_KEYS = new Set(["llmMessage", "providerSidecarData", "visual_display", "toolCall", "toolCallId", "usage", "display", "args"]);

/** Extract text-only parts from an LLM content array (skips thinking blocks). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .filter(p => p.type === "text" && typeof p.text === "string")
    .map(p => p.text as string)
    .join("\n");
}

/** Strip noise keys; for user/assistant messages, extract text from llmMessage instead of dropping it. */
function cleanPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const base = Object.fromEntries(Object.entries(payload).filter(([k]) => !NOISE_KEYS.has(k)));
  if (type === "hook:assistantMessage" || type === "inbound_message") {
    const msg = payload.llmMessage as Record<string, unknown> | undefined;
    base.text = msg ? extractText(msg.content) : "";
  }
  return base;
}

/** Convert events into a text block for the summarizer. */
function eventsToSummaryInput(events: StoredEvent[]): string {
  return events
    .filter(ev => !SKIP_TYPES.has(ev.type))
    .map(ev => {
      const time = formatTime(ev.ts);
      const label = ev.type.replace("hook:", "");
      const cleaned = ev.payload ? cleanPayload(ev.type, ev.payload) : null;
      return cleaned ? `[${time}] ${label}: ${JSON.stringify(cleaned)}` : `[${time}] ${label}`;
    }).join("\n");
}

export default function create(ctx: AgentContext): PluginSource & { flush(): Promise<void> } {
  const config = getConfig(ctx);
  if (config.enabled === false) {
    return { name: "auto_daily", start() {}, stop() {}, async flush() {} };
  }

  const toolCallThreshold = config.toolCallThreshold ?? 8;
  const maxEventsPerSummary = config.maxEventsPerSummary ?? 500;
  const MAX_CONSECUTIVE_FAILURES = 3;

  let running = false;
  let consecutiveFailures = 0;
  let unsubscribe: (() => void) | null = null;

  /** Count tool_use events since the watermark timestamp. */
  async function countToolCallsSinceWatermark(): Promise<number> {
    const sm = ctx.ledger;
    if (!sm) return 0;
    const watermark = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEY) as DailyWatermark | undefined;
    const lastTs = watermark?.lastSummarizedTs ?? Date.now();
    const allEvents = await sm.readEvents();
    return allEvents.filter(ev => ev.ts > lastTs && ev.type === Hook.ToolCall).length;
  }

  function advanceWatermark(ts: number): void {
    ctx.teamBoard.set(ctx.agentId, TEAMBOARD_KEY, {
      lastSummarizedTs: ts,
    } satisfies DailyWatermark, { persist: true });
  }

  async function flush(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const sm = ctx.ledger;
      if (!sm) return;

      const watermark = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEY) as DailyWatermark | undefined;
      const lastTs = watermark?.lastSummarizedTs ?? 0;

      const allEvents = await sm.readEvents();
      const newEvents = allEvents.filter(ev => ev.ts > lastTs);

      if (newEvents.length === 0) return;

      // Cap events to avoid prompt explosion; remainder stays for next flush
      const batch = newEvents.slice(0, maxEventsPerSummary);
      const truncated = newEvents.length > maxEventsPerSummary;

      const summaryInput = eventsToSummaryInput(batch);
      if (!summaryInput.trim()) return;

      const mc = ConsciousAgent.resolveModelsConfig(ctx.getAgentJson());
      if (!mc.model) return;
      const provider = createProvider({
        ...mc,
        maxTokens: 1500,
        showThinking: false,
        temperature: 0.3,
      });

      const stream = provider.chatStream(
        [{ name: "auto_daily", text: SUMMARIZE_PROMPT, cacheHint: "stable", priority: 0 }],
        [{ role: "user", content: [{ type: "text", text: summaryInput }] }],
        [],
        ctx.signal,
      );
      const response = await assembleResponse(stream);
      const summaryText = (typeof response.content === "string"
        ? response.content
        : response.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n")
      ).trim();
      if (!summaryText) return;

      const now = Date.now();
      const dateStr = formatDate(now);
      const timeStr = formatTime(now);
      const homeDir = ctx.pathManager.team().homeFor(ctx.agentId);
      const dailyDir = join(homeDir, "memories", "daily");
      const dailyPath = join(dailyDir, `${dateStr}.md`);

      getSandboxFs().mkdirSync(dailyDir);

      const section = `\n## ${timeStr} 自动记录\n\n${summaryText}\n`;

      if (getSandboxFs().existsSync(dailyPath)) {
        getSandboxFs().appendTextSync(dailyPath, section);
      } else {
        getSandboxFs().writeTextSync(dailyPath, `# ${dateStr}\n${section}`);
      }

      const lastBatchEvent = batch[batch.length - 1];
      advanceWatermark(lastBatchEvent.ts);
      consecutiveFailures = 0;

      const extra = truncated ? ` (truncated, ${newEvents.length - maxEventsPerSummary} events deferred)` : "";
      console.log(`[auto_daily] wrote summary to ${dailyPath} (${batch.length} events)${extra}`);
    } catch (err: any) {
      consecutiveFailures++;
      console.warn(`[auto_daily] error (attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err?.message ?? err}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const sm = ctx.ledger;
        if (sm) {
          const watermark = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEY) as DailyWatermark | undefined;
          const lastTs = watermark?.lastSummarizedTs ?? 0;
          const allEvents = await sm.readEvents();
          const stale = allEvents.filter(ev => ev.ts > lastTs);
          if (stale.length > 0) {
            const skipTo = stale[Math.min(maxEventsPerSummary, stale.length) - 1];
            advanceWatermark(skipTo.ts);
            console.log(`[auto_daily] skipped ${Math.min(maxEventsPerSummary, stale.length)} stale events after ${MAX_CONSECUTIVE_FAILURES} failures`);
          }
        }
        consecutiveFailures = 0;
      }
    } finally {
      running = false;
    }
  }

  return {
    name: "auto_daily",

    start() {
      running = false;
      if (!ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEY)) {
        ctx.teamBoard.set(ctx.agentId, TEAMBOARD_KEY, {
          lastSummarizedTs: Date.now(),
        } satisfies DailyWatermark, { persist: true });
      }
      unsubscribe = ctx.eventBus.observeAgent(ctx.agentId, (event) => {
        if (event.type !== Hook.TurnEnd) return;
        countToolCallsSinceWatermark()
          .then(count => {
            if (count >= toolCallThreshold) {
              setTimeout(() => { flush().catch(() => {}); }, 500);
            }
          })
          .catch(() => {});
      });
    },

    stop() {
      running = false;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },

    async flush() {
      await flush();
    },
  };
}
