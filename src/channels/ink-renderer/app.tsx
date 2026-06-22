/**
 * InkApp — Root React component for ink-renderer.
 *
 * Pure orchestration hub: wires extracted hooks together and delegates all
 * visual rendering to ScreenLayout.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ScrollBoxHandle } from "./ink/components/ScrollBox.js";
import type {
  RendererCallbacks,
  RendererDataSource,
  InputSegment,
} from "./types.js";
import { useOverlayScheduler } from "./hooks/use-overlay-scheduler.js";
import { useOverlayHelpers } from "./hooks/use-overlay.js";
import { useSlashCommands } from "./hooks/use-slash-commands.js";
import { useEventBridge } from "./hooks/use-event-bridge.js";
import { useStartupFlow } from "./hooks/use-startup-flow.js";
import { useGlobalKeys } from "./hooks/use-global-keys.js";
import { useReservedQueue, type ReservedItem } from "./hooks/use-reserved-queue.js";
import { useDraftPersistence } from "./hooks/use-draft-persistence.js";
import { useRemoteCommands } from "./hooks/use-remote-commands.js";
import type { InputBoxControl } from "./components/InputBox.js";
import { CtrlCLayerContext } from "./hooks/use-ctrl-c-chain.js";
import { PromptOverlayProvider } from "./hooks/prompt-overlay-context.js";
import { segmentsToVisualDisplay } from "../shared/input-segments.js";
import { inputSegmentsToEventContent } from "./lib/input-submit-adapter.js";
import { ColumnsContext, OverlaySchedulerContext, DataSourceContext, CallbacksContext } from "./lib/contexts.js";
import { ScreenLayout } from "./components/ScreenLayout.js";

interface InkAppProps {
  callbacks: RendererCallbacks;
  dataSource: RendererDataSource;
  onExit?: () => void;
  onInterrupt?: (agentId?: string) => void;
  onSwitchInstance?: (id: string) => void;
}

export function InkApp({
  callbacks,
  dataSource,
  onExit,
  onInterrupt,
  onSwitchInstance,
}: InkAppProps): React.JSX.Element {
  // ── Terminal columns ──
  const [columns, setColumns] = useState(process.stdout.columns ?? 80);
  useEffect(() => {
    const onResize = () => setColumns(process.stdout.columns ?? 80);
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  const scrollRef = useRef<ScrollBoxHandle>(null);
  const scrollToBottom = useCallback(() => {
    queueMicrotask(() => {
      const handle = scrollRef.current;
      if (handle && handle.isSticky()) handle.scrollToBottom();
    });
  }, []);

  // ── Shared state (owned here, consumed by multiple hooks) ──
  const [instanceId, setInstanceId] = useState("");
  const [activeAgent, setActiveAgent] = useState("");
  const activeAgentRef = useRef(activeAgent);
  activeAgentRef.current = activeAgent;

  // 0. Worker commands — polled for autocomplete merging with built-in SLASH_COMMANDS
  const { commands: remoteCommands } = useRemoteCommands({ callbacks, requestingAgentId: activeAgent });

  // 1. Overlay scheduler
  const scheduler = useOverlayScheduler();

  // 2. Event bridge — core rendering state + event subscription
  const bridge = useEventBridge(callbacks, dataSource, activeAgentRef, activeAgent, scrollToBottom);

  // 3. Startup flow (replaySession needed by overlay helpers, so create it first)
  //    But startup also needs overlay helpers... break the cycle with a ref.
  const showInstancePickerRef = useRef<() => void>(() => {});
  const showAgentPickerRef = useRef<(layout?: any) => void>(() => {});
  const showLoadPackRef = useRef<() => void>(() => {});

  const startup = useStartupFlow({
    scheduler,
    dataSource,
    instanceId,
    activeAgent,
    showInstancePicker: () => showInstancePickerRef.current(),
    showAgentPicker: (layout) => showAgentPickerRef.current(layout),
    showLoadPack: () => showLoadPackRef.current(),
    onSwitchInstance,
    setActiveAgent,
    setInstanceId,
    setCompletedTurns: bridge.setCompletedTurns,
    setSessionLabel: bridge.setSessionLabel,
    setContextPct: bridge.setContextPct,
    scrollToBottom,
  });

  // 4. Overlay helpers
  const {
    showAgentPicker, showInstancePicker, showDeleteCurrentAgent,
    showDeleteInstancePicker, showPackCleanImage, showRemoveContainers, showSyncPack,
    showLoadPack, showLoadPackForInstance, showTeamRestore,
  } = useOverlayHelpers({
    scheduler,
    dataSource,
    activeAgent,
    instanceId,
    setActiveAgent,
    setCompletedTurns: bridge.setCompletedTurns,
    setInstanceId: startup.handleInstanceSwitch,
    replaySession: startup.replaySession,
    scrollToBottom,
  });

  showInstancePickerRef.current = showInstancePicker;
  showAgentPickerRef.current = showAgentPicker;
  showLoadPackRef.current = () => showLoadPackForInstance(instanceId);

  // 4a. Auto-show instance picker when current instance enters error state
  const errorShownForRef = useRef("");
  useEffect(() => {
    if (!instanceId || !dataSource.listInstances) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        await new Promise(r => setTimeout(r, 5000));
        if (cancelled || scheduler.isActive()) continue;
        try {
          const all = await dataSource.listInstances!();
          const cur = all.find(i => i.id === instanceId);
          if (!cur || cur.status !== "error") { errorShownForRef.current = ""; continue; }
          if (errorShownForRef.current === instanceId) continue;
          errorShownForRef.current = instanceId;
          showInstancePicker();
        } catch {}
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [instanceId, dataSource, scheduler, showInstancePicker]);

  // 5. Reserved queue — buffers user inputs typed while the agent is busy.
  //    Created BEFORE useGlobalKeys so the global Ctrl+C chain can register a
  //    queue-pop guard pointing at this state.
  const reservedQueue = useReservedQueue();

  // 5a. Imperative handle to InputBox, used by draft persistence to read /
  //     restore the editor contents without requiring a remount.
  const inputControlRef = useRef<InputBoxControl | null>(null);

  // 5b. Draft persistence — wires the cache file to the live UI scoped per
  //     (instance, agent). Restores on mount of each pair, flushes on switch
  //     and on a ~2s heartbeat for crash safety.
  const draft = useDraftPersistence({
    dataSource,
    instanceId,
    activeAgent,
    reservedQueue,
    inputControlRef,
  });

  // Suppress the next auto-flush (set when the user explicitly interrupts the
  // agent via Ctrl+C — we don't want the interrupt to be immediately undone by
  // dispatching a queued message).
  const suppressAutoFlushRef = useRef(false);

  const wrappedOnInterrupt = useCallback(() => {
    suppressAutoFlushRef.current = true;
    onInterrupt?.(activeAgentRef.current || undefined);
  }, [onInterrupt]);

  // Flush the draft synchronously before handing control back to the channel
  // layer (which calls process.exit). The hook also registers a 'process exit'
  // catch-all for non-onExit teardown paths.
  const wrappedOnExit = useCallback(() => {
    draft.flushNowSync();
    onExit?.();
  }, [draft, onExit]);

  // 6. Global keys (CtrlC chain + scroll + Ctrl+D exit + queue-pop guard)
  const { mainLayerApi } = useGlobalKeys({
    scrollRef,
    scheduler,
    onExit: wrappedOnExit,
    onInterrupt: wrappedOnInterrupt,
    isThinking: bridge.isThinking,
    reservedQueue,
  });

  // 7. Slash commands
  const handleSlashCommand = useSlashCommands({
    scheduler,
    callbacks,
    dataSource,
    activeAgentRef,
    instanceId,
    showAgentPicker,
    showInstancePicker,
    showDeleteCurrentAgent,
    showDeleteInstancePicker,
    showPackCleanImage,
    showRemoveContainers,
    showSyncPack,
    showLoadPack,
    showTeamRestore,
    setCompletedTurns: bridge.setCompletedTurns,
    scrollToBottom: () => queueMicrotask(() => scrollRef.current?.scrollToBottom()),
  });

  // 8. User input handlers
  //
  // Reserved-queue policy (see hooks/use-reserved-queue.ts):
  //   - turn submit while agent is RUNNING → enqueue, do not dispatch
  //   - turn submit while agent is IDLE     → dispatch immediately as turn
  //   - steer submit                        → always dispatch immediately as steer
  //   - manual flush ([send] / Ctrl+Enter)  → dispatch as steer  (interrupts agent)
  //   - auto flush  (turn ended naturally)  → dispatch as turn   (next normal turn)
  //
  // We read isThinking through a ref so the closure doesn't stale-capture
  // across React commits between keystroke and submit.
  const isAgentRunningRef = useRef(bridge.isThinking);
  isAgentRunningRef.current = bridge.isThinking;
  const reservedQueueRef = useRef(reservedQueue);
  reservedQueueRef.current = reservedQueue;

  const dispatchAs = useCallback(async (
    handoff: "turn" | "steer",
    segments: InputSegment[],
  ) => {
    // Snapshot active agent at decision time. `inputSegmentsToEventContent`
    // is async (file/media → base64), and the user can switch agents during
    // the await — without this binding, the message would land on the new
    // agent. Auto-flush on turn-end is especially prone to this race.
    const targetAgent = activeAgentRef.current;
    const visualDisplay = segmentsToVisualDisplay(segments);
    const content = await inputSegmentsToEventContent(segments);
    callbacks.onUserInput(targetAgent, content, handoff, { text: visualDisplay, segments });
  }, [callbacks]);

  const handleSubmit = useCallback(async (text: string, segments: InputSegment[]) => {
    if (isAgentRunningRef.current) {
      reservedQueueRef.current.enqueue(text, segments);
      return;
    }
    await dispatchAs("turn", segments);
  }, [dispatchAs]);

  const handleSteerSubmit = useCallback(async (_text: string, segments: InputSegment[]) => {
    await dispatchAs("steer", segments);
  }, [dispatchAs]);

  // Manual flush — user explicitly clicks [send] or hits Ctrl+Enter on an
  // empty input. Steer semantics: interrupt the running agent with this item.
  // When the agent is already idle, fall back to turn (steer would no-op).
  const flushReservedManual = useCallback(async (item: ReservedItem) => {
    const handoff: "turn" | "steer" = isAgentRunningRef.current ? "steer" : "turn";
    await dispatchAs(handoff, item.segments);
  }, [dispatchAs]);

  const handleFlushReservedById = useCallback((id: string) => {
    const popped = reservedQueueRef.current.removeById(id);
    if (popped) void flushReservedManual(popped);
  }, [flushReservedManual]);

  const handleFlushReservedHead = useCallback(() => {
    const head = reservedQueueRef.current.dequeueHead();
    if (head) void flushReservedManual(head);
  }, [flushReservedManual]);

  const handleRemoveReserved = useCallback((id: string) => {
    reservedQueueRef.current.removeById(id);
  }, []);

  // ── Auto-flush on natural turn end ──
  //
  // When the agent transitions running→false WITHOUT a user-triggered
  // interrupt, drain the head of the queue as a normal turn. This is what
  // makes a "queued question" feel like the user simply pressed Enter again
  // the moment the previous turn settled.
  //
  // The cascade self-perpetuates: dispatching a turn flips running back to
  // true; when it ends we hit this effect again and pop the next head, until
  // the queue is empty or an interrupt sets the suppress flag.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = bridge.isThinking;
    if (!wasRunning || bridge.isThinking) return;

    if (suppressAutoFlushRef.current) {
      suppressAutoFlushRef.current = false;
      return;
    }

    const head = reservedQueueRef.current.dequeueHead();
    if (head) void dispatchAs("turn", head.segments);
  }, [bridge.isThinking, dispatchAs]);

  // ── Render ──
  return (
    <CtrlCLayerContext.Provider value={mainLayerApi}>
    <ColumnsContext.Provider value={columns}>
    <OverlaySchedulerContext.Provider value={scheduler}>
    <DataSourceContext.Provider value={dataSource}>
    <CallbacksContext.Provider value={callbacks}>
    <PromptOverlayProvider>
      <ScreenLayout
        turns={bridge.completedTurns}
        scrollRef={scrollRef}
        columns={columns}
        streamText={bridge.streamText}
        isThinking={bridge.isThinking}
        thinkingText={bridge.thinkingText}
        instanceId={instanceId}
        activeAgent={activeAgent}
        contextPct={bridge.contextPct}
        agentStatus={bridge.agentStatus}
        thinkingStartMs={bridge.thinkingStartMs}
        lastCompletedTurnDurationMs={bridge.lastCompletedTurnDurationMs}
        turnTokens={bridge.turnTokens}
        onSubmit={handleSubmit}
        onSteerSubmit={handleSteerSubmit}
        onSlashCommand={handleSlashCommand}
        reservedItems={reservedQueue.items}
        onFlushReservedById={handleFlushReservedById}
        onFlushReservedHead={handleFlushReservedHead}
        onRemoveReserved={handleRemoveReserved}
        inputControlRef={inputControlRef}
        remoteCommands={remoteCommands}
      />
    </PromptOverlayProvider>
    </CallbacksContext.Provider>
    </DataSourceContext.Provider>
    </OverlaySchedulerContext.Provider>
    </ColumnsContext.Provider>
    </CtrlCLayerContext.Provider>
  );
}
