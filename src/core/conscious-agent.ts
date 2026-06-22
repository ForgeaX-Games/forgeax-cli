/** @desc ConsciousAgent — streaming agent loop with handoff-aware scheduling */

import type {
  AgentInitConfig,
  AgentJson,
  Event,
  ToolDefinition,
  AgentContext,
  ModelSpec,
} from "./types.js";
import type { LLMProvider, LLMMessage, LLMToolCall, LLMResponse } from "../llm/types.js";
import { createFallbackProvider, getModelSpec, mergeModelsConfig } from "../llm/provider.js";
import { contentToString, normalizeContent } from "../message/modality.js";
import { stripThinkingBlocks } from "../llm/thinking.js";
import type { ModelsConfig } from "./types.js";
import { ContextEngine } from "../capability/slot/context-engine.js";
import { ContextWindow } from "../context-window/context-window.js";
import {
  assembleResponseWithCallback,
  getPartialResponse,
} from "../llm/stream.js";
import { isRetryable } from "../llm/errors.js";
import { Hook } from "../hooks/types.js";
import { runToolBatch } from "../capability/tool/tool-batch-runner.js";
import { resolveTool } from "../capability/tool/tool-executor.js";
import { bareName } from "../registries/name-lookup.js";
import { BaseAgent } from "./base-agent.js";
import { runWithAgentTurn, withModelFeedback } from "./logger.js";
import { AGENT_DEFAULTS } from "../defaults/agent/agent-json.js";
import {
  TEAMBOARD_KEYS,
  buildBuiltinTeamBoardVars,
} from "../defaults/teamboard-vars.js";
import { eventToSessionMessage } from "../message/message-ingress.js";
import { getPathManager } from "../fs/path-manager.js";
import { getSharedPaths } from "../fs/state-dir.js";
import { diffSystemBlocks } from "../context-window/system-snapshot.js";
import { ModelRoutingHints } from "./model-routing.js";
import { sleep } from "../utils.js";
import { readFileSync } from "node:fs";

// ─── Reusable agent loop (persistent session backed) ───

export interface AgentLoopOpts {
  agentContext: AgentContext;
  provider: LLMProvider;
  getTools: () => ToolDefinition[];
  contextEngine: ContextEngine;
  modelSpec: ModelSpec;
  maxIterations: number;
  contextWindow: ContextWindow;
  turn?: number;
  onAssistantMessage?: (model?: string) => void;
  keepRecentTools?: number;
  keepRecentMedias?: number;
  idleGapMs?: number;
  showThinking?: boolean;
  absorbInnerLoopEvents?: () => Promise<boolean>;
  drainPendingCommands?: () => Promise<boolean>;
  refreshTools?: () => Promise<void>;
  timezone?: string;
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<LLMResponse | null> {
  const { agentContext, provider, getTools, contextEngine, modelSpec, maxIterations, contextWindow } = opts;
  const { agentId, signal, eventBus, teamBoard } = agentContext;
  const turn = opts.turn ?? 0;

  return await runWithAgentTurn(agentId, turn, async () => {
    const {
      onAssistantMessage,
      keepRecentTools = 20, keepRecentMedias = 2,
      idleGapMs,
      showThinking = false,
      absorbInnerLoopEvents: absorbInnerLoop,
    } = opts;

    const lifecycle = contextWindow;
    const MAX_EMPTY_RETRIES = 2;
    let iterations = 0;
    let emptyRetries = 0;
    let lastResponse: LLMResponse | null = null;

    const materializeAssistantMessage = (
      response: LLMResponse,
      options: { showThinking: boolean; ts: number; truncated?: boolean },
    ): LLMMessage => provider.materializeAssistantMessage!(response, options);

    const emitAssistant = (msg: LLMMessage, response?: LLMResponse): void => {
      eventBus.hook(Hook.AssistantMessage, {
        llmMessage: msg, turn,
        model: response?.model, usage: response?.usage, providerSidecarData: response?.providerSidecarData,
      });
      onAssistantMessage?.(response?.model);
    };

    const absorbInnerLoopEvents = absorbInnerLoop ?? (async () => false);

    const toolCtx = agentContext;

    for (;;) {
      if (signal.aborted || (maxIterations != -1 && iterations >= maxIterations) ) break;
      iterations++;

      const sessionHistory = await contextWindow.buildPrompt({
        keepRecentTools, keepRecentMedias,
        idleGapMs,
        toolDefs: getTools(),
      });

      const tz = opts.timezone ?? "Asia/Shanghai";
      teamBoard.set(
        agentId,
        TEAMBOARD_KEYS.CURRENT_TIME,
        new Date().toLocaleString("zh-CN", { timeZone: tz }),
        { persist: false },
      );

      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(teamBoard.getAll(agentId))) {
        vars[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      const { system, messages } = await contextEngine.assemblePrompt(
        toolCtx,
        sessionHistory,
        modelSpec,
        undefined,
        vars,
      );

      if (system.length > 0) {
        const previousSnapshot = await lifecycle.buildSystemSnapshot();
        const delta = diffSystemBlocks(previousSnapshot, system);
        if (delta) {
          eventBus.hook(Hook.SystemPrompt, {
            changed: delta.changed,
            ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
          });
        }
      }

      const allTools = getTools();
      const tools = allTools.filter(t => !t.condition || t.condition(toolCtx, t));

      // Derive display names: use bare name when unique, qualified name when ambiguous
      const bareCount = new Map<string, number>();
      for (const t of tools) {
        const bare = bareName(t.name);
        bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
      }
      const displayName = (qn: string) => {
        const bare = bareName(qn);
        return (bareCount.get(bare) ?? 0) > 1 ? qn : bare;
      };

      // Build LLM-facing tool defs with display names (bare when unique, qualified when ambiguous)
      const llmTools = tools.map((t) => ({ ...t, name: displayName(t.name) }));

      teamBoard.set(agentId, TEAMBOARD_KEYS.ACTIVE_TOOLS, llmTools.map((t) => ({
        name: t.name,
        description: t.description,
        guidance: t.guidance,
        input_schema: t.input_schema,
      })), { persist: false });

      console.debug(`LLM call: ${messages.length} msgs, ${llmTools.length} tools, session=${sessionHistory.length}`);

      let response: LLMResponse;
      try {
        const stream = provider.chatStream(system.length > 0 ? system : undefined, messages, llmTools, signal);
        response = await assembleResponseWithCallback(stream, (event) => {
          eventBus.hook(Hook.StreamLLM, { chunk: event, turn });
        });
      } catch (err: any) {
        if (signal.aborted) {
          console.log("LLM call aborted");
          break;
        }
        withModelFeedback(() => console.error(`LLM call failed: ${err.message}`));
        const partialResponse = getPartialResponse(err);
        const partialText = partialResponse ? contentToString(partialResponse.content) : "";

        if (partialText.trim() || partialResponse?.thinking?.trim()) {
          emitAssistant(materializeAssistantMessage(
            { ...partialResponse!, toolCalls: undefined },
            { showThinking, truncated: true, ts: Date.now() },
          ), partialResponse);
        }

        if (isRetryable(err)) break;
        throw err;
      }

      if (response.truncated) {
        console.log("LLM stream aborted mid-flight; saving partial response");
        const raw = contentToString(response.content);
        if (raw.trim() || response.thinking?.trim()) {
          const partialMsg = materializeAssistantMessage(response, {
            showThinking,
            truncated: true,
            ts: Date.now(),
          });
          emitAssistant(partialMsg, response);
        }
        break;
      }

      const responseText = contentToString(response.content);
      const responseHasMedia = normalizeContent(response.content).some((part) => part.type !== "text");
      console.debug(
        `LLM response: content=${responseText ? responseText.length : responseHasMedia ? "multimodal" : 0} chars, tools=${response.toolCalls?.length ?? 0}`,
      );

      lastResponse = response;

      const assistantMsg = materializeAssistantMessage(response, {
        showThinking,
        ts: Date.now(),
      });

      if (signal.aborted) {
        assistantMsg.truncated = true;
        emitAssistant(assistantMsg, response);
        break;
      }

      const textContent = contentToString(assistantMsg.content);
      const displayContent = stripThinkingBlocks(textContent);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (!displayContent) {
          if (emptyRetries < MAX_EMPTY_RETRIES) {
            emptyRetries++;
            console.warn(`LLM returned empty response, retrying (${emptyRetries}/${MAX_EMPTY_RETRIES})`);
            continue;
          }
          console.log("LLM returned empty response (no content, no tool calls)");
        }
      }

      emitAssistant(assistantMsg, response);

      if (displayContent) {
        console.log(displayContent);
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (await absorbInnerLoopEvents()) continue;
        if (await opts.drainPendingCommands?.()) continue;
        break;
      }

      emptyRetries = 0;

      await runToolBatch({
        toolCalls: response.toolCalls,
        tools,
        toolCtx,
        materializePending: (toolCalls) =>
          provider.materializePendingToolMessages!(toolCalls, { ts: Date.now() }),
        materializeResult: (toolCall, result) =>
          provider.materializeToolResult!(toolCall, result, { ts: Date.now() }),
        turn,
      });
      await opts.refreshTools?.();
      await opts.drainPendingCommands?.();
      await absorbInnerLoopEvents();
    }

    return lastResponse;
  });
}

// ─── ConsciousAgent ───

export class ConsciousAgent extends BaseAgent {
  private readonly provider: LLMProvider;
  private readonly contextEngine: ContextEngine;
  readonly contextWindow: ContextWindow;
  private currentTurn = 0;
  private readonly modelRoutingHints: ModelRoutingHints;

  get isTurnActive(): boolean {
    return !this.abortController.signal.aborted;
  }

  private commandQueue: Array<{ toolName: string; args: Record<string, string>; reason?: string }> = [];

  /**
   * Resolve models config: agent-level first, fallback to agenteam.json global.
   * Static so other subsystems (e.g. compaction) can reuse the same resolution logic.
   */
  static resolveModelsConfig(agentJson: AgentJson): ModelsConfig {
    const agent = agentJson.models ?? {};
    if (agent.model) return agent;

    const global = ConsciousAgent.readGlobalModels();
    return mergeModelsConfig(global, agent);
  }

  private static readGlobalModels(): ModelsConfig {
    try {
      const raw = readFileSync(getSharedPaths().agenteamConfig(), "utf-8");
      const cfg = JSON.parse(raw);
      if (!cfg.models) {
        console.error("[config] agenteam.json 中未配置 models");
        return {};
      }
      return cfg.models;
    } catch (err: any) {
      console.error(`[config] 无法读取 agenteam.json: ${err?.message ?? err}`);
      return {};
    }
  }

  constructor(config: AgentInitConfig) {
    super(config);
    this.modelRoutingHints = new ModelRoutingHints(this.id);
    const resolveModels = () => ConsciousAgent.resolveModelsConfig(this.agentJson);

    this.provider = createFallbackProvider(
      () => this.modelRoutingHints.order(resolveModels()),
      {
        onRetry: (model, info) => {
          const msg = `LLM 降级链全部失败，${info.delayMs}ms 后重试 (${info.attempt}/${info.maxRetries}): ${info.error.message}`;
          this.boundEventBus.hook(Hook.LLMRetry, { warning: msg });
        },
        onFallback: (from, to, error) => {
          this.modelRoutingHints.recordFallback(resolveModels(), from, error);
          const msg = `模型 ${from} 失败，回退到 ${to}: ${error.message}`;
          this.boundEventBus.hook(Hook.LLMFallback, { warning: msg });
        },
      },
    );

    this.watchAgentJson();

    this.contextEngine = new ContextEngine(this.slotRegistry);
    this.contextWindow = new ContextWindow(this.id, this.ledger, this.teamBoard);

    // ─── Built-in teamBoard vars ────────────────────────────────────────────
    const builtinVars = buildBuiltinTeamBoardVars(
      this.id,
      config.agentDir,
      getPathManager(),
      this.agentJson,
    );
    for (const [key, { value, persist }] of Object.entries(builtinVars)) {
      if (this.teamBoard.get(this.id, key) === undefined) {
        this.teamBoard.set(this.id, key, value, { persist });
      }
    }
  }

  protected async runMain(_signal: AbortSignal): Promise<void> {
    while (!this.shuttingDown) {
      if (this.abortController.signal.aborted) {
        this.abortController = new AbortController();
      }
      const turnSignal = this.abortController.signal;

      while (this.commandQueue.length > 0 && !turnSignal.aborted) {
        const cmd = this.commandQueue.shift()!;
        this.currentTurn++;
        try {
          await this.withAgentTurn(this.currentTurn, async () => {
            await this.executeCommand(cmd.toolName, cmd.args, cmd.reason, turnSignal);
          });
        } catch (err: any) {
          if (!turnSignal.aborted) {
            withModelFeedback(() => console.error(`command failed: ${err?.message ?? err}`));
          }
        }
      }
      if (turnSignal.aborted) continue;

      let trigger: Event;
      try {
        trigger = await this.queue.waitForEvent(turnSignal);
      } catch {
        continue;
      }

      if (this.queue.hasHandoff("steer")) {
        // Skip coalesce for steer events — process immediately
      } else if ((trigger.priority ?? 1) > 0 && this.coalesceMs > 0) {
        await sleep(this.coalesceMs);
      }

      const events = this.queue.drain().filter(e => eventToSessionMessage(e) !== null);
      if (events.length === 0) continue;

      this.currentTurn++;

      const steerWatcher = this.queue.onSteer(() => {
        this.abortController.abort();
      });

      console.log(`▶ process [${events.length} events]`);

      try {
        await this.withAgentTurn(this.currentTurn, async () => {
          await this.process(events, turnSignal);
        });
      } catch (err: any) {
        if (turnSignal.aborted) {
          console.log("turn aborted");
        } else {
          withModelFeedback(() => console.error(`process failed: ${err?.message ?? err}`));
        }
      } finally {
        steerWatcher.dispose();
      }
    }
  }

  private async prepareInboundMessages(
    events: Event[], signal: AbortSignal,
  ): Promise<{ msg: LLMMessage; event: Event }[]> {
    const results: { msg: LLMMessage; event: Event }[] = [];
    for (const event of events) {
      const inboundMsg = eventToSessionMessage(event);
      if (!inboundMsg) continue;
      const prepared = await this.provider.prepareInboundMessages!([inboundMsg], { signal });
      for (const msg of prepared) {
        results.push({ msg, event });
      }
    }
    return results;
  }

  private async process(events: Event[], signal: AbortSignal): Promise<void> {
    if (events.length === 0) return;

    this.contextWindow.trackEvents(events);

    this.teamBoard.set(this.id, TEAMBOARD_KEYS.RUNNING, true, { persist: false });
    this.boundEventBus.hook(Hook.TurnStart, { turn: this.currentTurn, eventCount: events.length });
    let turnError: string | undefined;

    try {
      for (const { msg, event } of await this.prepareInboundMessages(events, signal)) {
        this.boundEventBus.publish({
          source: event.source,
          type: "inbound_message",
          payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
          ts: Date.now(),
        });
      }

      const MAX_CONTINUATIONS = this.agentJson.models?.maxRetries ?? AGENT_DEFAULTS.models.maxRetries;
      let continuationRetries = 0;

      while (!signal.aborted && continuationRetries < MAX_CONTINUATIONS) {
        const mc = this.modelRoutingHints.order(ConsciousAgent.resolveModelsConfig(this.agentJson));
        const currentModel = Array.isArray(mc.model) ? mc.model[0] : (mc.model ?? "");
        const lastResponse = await runAgentLoop({
          agentContext: { ...this.agentContext, signal },
          provider: this.provider,
          getTools: () => this.toolRegistry.all(),
          contextEngine: this.contextEngine,
          modelSpec: getModelSpec(currentModel),
          maxIterations: this.agentJson.maxIterations ?? AGENT_DEFAULTS.maxIterations,
          contextWindow: this.contextWindow,
          turn: this.currentTurn,
          onAssistantMessage: (model) =>
            this.modelRoutingHints.recordSuccess(ConsciousAgent.resolveModelsConfig(this.agentJson), model),
          keepRecentTools: this.agentJson.session?.keepRecentTools ?? AGENT_DEFAULTS.session.keepRecentTools,
          keepRecentMedias: this.agentJson.session?.keepRecentMedias ?? AGENT_DEFAULTS.session.keepRecentMedias,
          idleGapMs: this.agentJson.session?.idleGapMs ?? AGENT_DEFAULTS.session.idleGapMs,
          showThinking: this.agentJson.models?.showThinking ?? true,
          refreshTools: this.capabilityFlush
            ? async () => { await this.capabilityFlush!(); }
            : undefined,
          absorbInnerLoopEvents: async () => {
            const innerEvents = this.queue.drain((e) => (e.handoff ?? "turn") === "innerLoop");
            if (!innerEvents.length) return false;
            for (const { msg, event } of await this.prepareInboundMessages(innerEvents, signal)) {
              this.boundEventBus.publish({
                source: event.source,
                type: "inbound_message",
                payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
                ts: Date.now(),
              });
            }
            console.debug(`absorbed ${innerEvents.length} innerLoop events into current turn`);
            return true;
          },
          drainPendingCommands: async () => {
            if (this.commandQueue.length === 0) return false;
            const getTools = () => this.toolRegistry.all();
            const toolCtx: AgentContext = { ...this.agentContext, signal };
            while (this.commandQueue.length > 0 && !signal.aborted) {
              const cmd = this.commandQueue.shift()!;
              const tool = resolveTool(cmd.toolName, getTools());
              if (!tool) {
                // Plain console.warn auto-publishes agent_log to observers (UI sees);
                // wrapping in withModelFeedback would also inject into agent context,
                // but unknown-command is a user typo, not actionable by model.
                console.warn(`command: unknown tool '${cmd.toolName}'`);
                continue;
              }
              const callId = `cmd_${Date.now()}`;
              const toolCall: LLMToolCall = { id: callId, name: cmd.toolName, arguments: cmd.args };

              const assistantMsg = this.provider.materializeAssistantMessage!(
                { content: cmd.reason ?? `Executing: ${cmd.toolName}`, toolCalls: [toolCall] },
                { showThinking: true, ts: Date.now() },
              );
              this.boundEventBus.hook(Hook.AssistantMessage, { llmMessage: assistantMsg, turn: this.currentTurn });

              await runToolBatch({
                toolCalls: [toolCall],
                tools: getTools(),
                toolCtx,
                materializePending: (tcs) =>
                  this.provider.materializePendingToolMessages!(tcs, { ts: Date.now() }),
                materializeResult: (tc, r) =>
                  this.provider.materializeToolResult!(tc, r, { ts: Date.now() }),
                turn: this.currentTurn,
              });
              if (this.capabilityFlush) await this.capabilityFlush();
              console.log(`command /${cmd.toolName} drained in agent loop`);
            }
            return true;
          },
          timezone: this.agentJson.timezone,
        });

        if (!lastResponse?.truncated) break;

        continuationRetries++;
        console.warn(`breakpoint continuation (${continuationRetries}/${MAX_CONTINUATIONS})`);

        const continueEvent: Event = {
          source: `agent:${this.id}`,
          type: "breakpoint_continuation",
          payload: {
            content:
              "Continue from where you left off. " +
              "Do not repeat any previously generated content. " +
              "If you were generating a tool call, re-issue it completely.",
          },
          ts: Date.now(),
        };
        for (const { msg, event } of await this.prepareInboundMessages([continueEvent], signal)) {
          this.boundEventBus.publish({
            source: event.source,
            type: "inbound_message",
            payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
            ts: Date.now(),
          });
        }

        await sleep(1500, signal);
      }
    } catch (err: any) {
      if (!signal.aborted) {
        turnError = err?.message ?? String(err);
        console.error(`process failed: ${turnError}`);
      }
    } finally {
      this.boundEventBus.hook(Hook.TurnEnd, { turn: this.currentTurn, aborted: signal.aborted, error: turnError });
      this.teamBoard.set(this.id, TEAMBOARD_KEYS.RUNNING, false, { persist: false });
    }
  }

  private async executeCommand(
    toolName: string, args: Record<string, string>, reason: string | undefined, signal: AbortSignal,
  ): Promise<void> {
    const tool = resolveTool(toolName, this.toolRegistry.all());
    if (!tool) {
      // Plain console.warn — auto-published to observers; not injected into model context.
      console.warn(`command: unknown tool '${toolName}'`);
      return;
    }

    const callId = `cmd_${Date.now()}`;
    const toolCall: LLMToolCall = { id: callId, name: toolName, arguments: args };

    const commandEvent: Event = {
      source: `agent:${this.id}`,
      type: "agent_command",
      payload: { content: reason ?? toolName, toolName },
      ts: Date.now(),
    };
    for (const { msg, event } of await this.prepareInboundMessages([commandEvent], signal)) {
      this.boundEventBus.publish({
        source: event.source,
        type: "inbound_message",
        payload: { llmMessage: msg, turn: this.currentTurn, sourceTs: event.ts, originalType: event.type },
        ts: Date.now(),
      });
    }

    const assistantMsg: LLMMessage = this.provider.materializeAssistantMessage!(
      {
        content: reason ?? `Executing: ${toolName}`,
        toolCalls: [toolCall],
      },
      { showThinking: true, ts: Date.now() },
    );
    this.boundEventBus.hook(Hook.AssistantMessage, { llmMessage: assistantMsg, turn: this.currentTurn });

    const toolCtx: AgentContext = { ...this.agentContext, signal };

    this.teamBoard.set(this.id, TEAMBOARD_KEYS.RUNNING, true, { persist: false });
    this.boundEventBus.hook(Hook.TurnStart, { turn: this.currentTurn, eventCount: 1 });
    let results: Awaited<ReturnType<typeof runToolBatch>>;
    try {
      results = await runToolBatch({
        toolCalls: [toolCall],
        tools: this.toolRegistry.all(),
        toolCtx,
        materializePending: (toolCalls) =>
          this.provider.materializePendingToolMessages!(toolCalls, { ts: Date.now() }),
        materializeResult: (pendingToolCall, result) =>
          this.provider.materializeToolResult!(pendingToolCall, result, { ts: Date.now() }),
        turn: this.currentTurn,
      });
    } catch (err: any) {
      if (!signal.aborted) {
        withModelFeedback(() => console.error(`command failed: ${err?.message ?? err}`));
      }
      return;
    } finally {
      this.boundEventBus.hook(Hook.TurnEnd, { turn: this.currentTurn, aborted: signal.aborted });
      this.teamBoard.set(this.id, TEAMBOARD_KEYS.RUNNING, false, { persist: false });
    }

    const result = results[0]?.result;
    const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    console.log(`command /${toolName} → ${resultStr.slice(0, 200)}`);
  }

  queueCommand(toolName: string, args: Record<string, string>, reason?: string, interrupt = true): void {
    this.commandQueue.push({ toolName, args, reason });
    if (interrupt) this.abortController.abort();
  }

  // ─── Lifecycle: 3 levels ───

  override async shutdown(): Promise<void> {
    await super.shutdown();
    console.log("shutdown() complete");
  }

}
