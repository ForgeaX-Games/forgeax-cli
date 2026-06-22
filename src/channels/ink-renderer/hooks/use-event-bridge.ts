/**
 * useEventBridge — bridges TurnAccumulator event callbacks into React state.
 *
 * Owns: completedTurns, streamText, thinkingText, sessionLabel, contextPct, isThinking.
 * Provides the EventDispatch object and wires useEventSubscription.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type {
  RendererCallbacks,
  RendererDataSource,
  CompletedTurn,
  ToolCallMessage,
} from "../types.js";
import { useEventSubscription, type EventDispatch } from "./use-event-subscription.js";

interface UsagePayload {
  outputTokens?: number;
}

interface StreamUsageChunk extends UsagePayload {
  type?: string;
}

function getOutputTokens(usage: UsagePayload | undefined): number | null {
  if (!usage) return null;
  const output = usage.outputTokens ?? 0;
  return Number.isFinite(output) ? output : null;
}

export interface EventBridgeResult {
  completedTurns: CompletedTurn[];
  setCompletedTurns: React.Dispatch<React.SetStateAction<CompletedTurn[]>>;
  streamText: string;
  thinkingText: string;
  sessionLabel: string;
  setSessionLabel: React.Dispatch<React.SetStateAction<string>>;
  contextPct: number;
  setContextPct: React.Dispatch<React.SetStateAction<number>>;
  isThinking: boolean;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  agentStatus: string;
  thinkingStartMs: number;
  lastCompletedTurnDurationMs: number;
  turnTokens: number;
}

export function useEventBridge(
  callbacks: RendererCallbacks,
  dataSource: RendererDataSource,
  activeAgentRef: React.RefObject<string>,
  activeAgent: string,
  scrollToBottom: () => void,
): EventBridgeResult {
  const [completedTurns, setCompletedTurns] = useState<CompletedTurn[]>([]);
  const [streamText, setStreamText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [sessionLabel, setSessionLabel] = useState("");
  const [contextPct, setContextPct] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [thinkingStartMs, setThinkingStartMs] = useState(0);
  const [lastCompletedTurnDurationMs, setLastCompletedTurnDurationMs] = useState(0);
  const [turnTokens, setTurnTokens] = useState(0);
  const turnTokensRef = useRef(0);
  const committedTurnTokensRef = useRef(0);

  const setTurnTokensValue = useCallback((value: number) => {
    turnTokensRef.current = value;
    setTurnTokens(value);
  }, []);

  const dispatch: EventDispatch = {
    appendStreamText: (t) => setStreamText(prev => prev + t),
    appendThinkingText: (t) => setThinkingText(prev => prev + t),
    pushMessage: (msg) => {
      setCompletedTurns(prev => {
        const last = prev[prev.length - 1];
        if (last && last._draft) {
          const updated = [...prev];
          updated[updated.length - 1] = { ...last, messages: [...last.messages, msg] };
          return updated;
        }
        const agent = msg.agent || activeAgentRef.current;
        return [...prev, { agent, messages: [msg], timestamp: Date.now(), _draft: true }];
      });
      scrollToBottom();
    },
    updateMessage: (callId, msg) => {
      setCompletedTurns(prev => {
        for (let ti = prev.length - 1; ti >= 0; ti--) {
          const turn = prev[ti]!;
          const idx = turn.messages.findIndex(
            m => m.kind === "tool_call" && (m as ToolCallMessage).id === callId,
          );
          if (idx < 0) continue;
          const merged = { ...turn.messages[idx]!, ...msg };
          const newMsgs = turn.messages.slice();
          newMsgs[idx] = merged;
          const updated = [...prev];
          updated[ti] = { ...turn, messages: newMsgs };
          return updated;
        }
        return prev;
      });
    },
    commitTurn: (turn) => {
      const resolvedTurn = turn.agent ? turn : { ...turn, agent: activeAgentRef.current };
      setCompletedTurns(prev => {
        const last = prev[prev.length - 1];
        if (last && last._draft) {
          const updated = [...prev];
          updated[updated.length - 1] = resolvedTurn;
          return updated;
        }
        return [...prev, resolvedTurn];
      });
      scrollToBottom();
    },
    setSessionLabel,
    setContextPct,
    setIsThinking,
    resetStreaming: () => { setStreamText(""); setThinkingText(""); },
  };
  useEventSubscription(callbacks, dispatch, activeAgentRef, activeAgent);

  useEffect(() => {
    setStreamText("");
    setThinkingText("");
    setThinkingStartMs(0);
    setLastCompletedTurnDurationMs(0);
  }, [activeAgent]);

  // Poll TeamBoard RUNNING + STATUS keys; drive thinkingStartMs on state transition
  useEffect(() => {
    if (!activeAgent) return;
    const hasRunning = !!dataSource.isAgentRunning;
    const hasStatus = !!dataSource.getAgentStatus;
    if (!hasRunning && !hasStatus) return;
    let cancelled = false;
    let wasRunning = false;
    let turnStartMs = 0;
    const poll = async () => {
      while (!cancelled) {
        try {
          const [running, status] = await Promise.all([
            hasRunning ? dataSource.isAgentRunning!(activeAgent) : undefined,
            hasStatus ? dataSource.getAgentStatus!(activeAgent) : undefined,
          ]);
          if (!cancelled) {
            if (running !== undefined) {
              setIsThinking(running);
              if (running && !wasRunning) {
                turnStartMs = Date.now();
                setThinkingStartMs(turnStartMs);
                setLastCompletedTurnDurationMs(0);
              } else if (!running && wasRunning) {
                const durationMs = turnStartMs > 0 ? Date.now() - turnStartMs : 0;
                setThinkingStartMs(0);
                setLastCompletedTurnDurationMs(durationMs);
                turnStartMs = 0;
              }
              wasRunning = running;
            }
            if (status !== undefined) setAgentStatus(status);
          }
        } catch { /* ignore transient errors */ }
        await new Promise(r => setTimeout(r, 1500));
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [activeAgent, dataSource]);

  // `↓ tokens` reflects only the current turn's output tokens.
  // Use stream usage for live feedback, then settle on persisted
  // assistantMessage output totals for the same turn.
  useEffect(() => {
    const unsub = callbacks.observeEvents((event, emitterId) => {
      const agent = activeAgentRef.current;
      if (agent && emitterId !== agent && (event as Record<string, unknown>).to !== agent) return;

      const ev = event as { type?: string; payload?: Record<string, unknown> };
      if (ev.type === "hook:turnStart") {
        committedTurnTokensRef.current = 0;
        setTurnTokensValue(0);
        return;
      }

      if (ev.type === "hook:turnEnd") {
        return;
      }

      if (ev.type === "stream:llm") {
        const chunk = ev.payload?.chunk as StreamUsageChunk | undefined;
        if (chunk?.type !== "usage") return;
        const outputTokens = getOutputTokens(chunk);
        if (outputTokens === null) return;
        setTurnTokensValue(committedTurnTokensRef.current + outputTokens);
        return;
      }

      if (ev.type !== "hook:assistantMessage") return;
      const payload = ev.payload as Record<string, unknown> | undefined;
      const outputTokens = getOutputTokens(payload?.usage as UsagePayload | undefined);
      if (outputTokens !== null) {
        committedTurnTokensRef.current += outputTokens;
        setTurnTokensValue(committedTurnTokensRef.current);
      }
    });
    return unsub;
  }, [callbacks, setTurnTokensValue]);

  return {
    completedTurns,
    setCompletedTurns,
    streamText,
    thinkingText,
    sessionLabel,
    setSessionLabel,
    contextPct,
    setContextPct,
    isThinking,
    setIsThinking,
    agentStatus,
    thinkingStartMs,
    lastCompletedTurnDurationMs,
    turnTokens,
  };
}
