/**
 * SubagentPanel — fullscreen overlay showing a subagent's live + historical
 * message stream. Uses non-virtualized ScrollBox rendering: subagent sessions
 * are batch-replayed (all turns at once) so the virtual-scroll height cache
 * has no prior measurements for upper items, causing blank regions on scroll-up.
 * Full rendering avoids this; subagent sessions are small enough to afford it.
 *
 * Lifecycle:
 *   1. Replay: fetchAllEvents → parseEventLines → TurnAccumulator (batch) → setTurns
 *   2. Live:   subscribe to observeEvents, filter by subagentId, incremental TurnAccumulator
 */

import React, { useState, useEffect, useRef, useCallback, useContext } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { default as ScrollBox, type ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { Markdown, StreamingMarkdown } from "../ink/components/StreamingMarkdown.js";
import type { CompletedTurn, RendererDataSource, RendererMessage, ToolCallMessage, StoredEvent } from "../types.js";
import { parseEventLines } from "../lib/event-replay.js";
import { TurnAccumulator } from "../lib/turn-accumulator.js";
import { MessageRow, Spinner } from "./MessageRow.js";
import { CallbacksContext, ColumnsContext } from "../lib/contexts.js";
import { useScrollKeys } from "../hooks/use-scroll-keys.js";
import { theme } from "../lib/theme.js";

interface SubagentPanelProps {
  subagentId: string;
  dataSource: RendererDataSource;
}

function toStoredEvent(event: { source: string; type: string; payload: unknown; to?: string }, emitterId?: string) {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  return { type: event.type, ts: Date.now(), source: event.source, to: event.to, emitterId, payload: p };
}

function extractTaskContent(events: StoredEvent[]): string | null {
  const ev = events.find(e => e.type === "subagent_task");
  if (!ev) return null;
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const content = p.content;
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const text = (content as Array<Record<string, unknown>>)
      .filter(part => part.type === "text" && part.text)
      .map(part => String(part.text))
      .join("\n");
    return text || null;
  }
  return null;
}

function SectionDivider({ label, color }: { label: string; color: string }) {
  const columns = useContext(ColumnsContext);
  const ruleLen = Math.max(0, columns - label.length - 6);
  return (
    <Box marginTop={1} marginBottom={0}>
      <Text color={color} bold>{"─".repeat(2)} {label} {"─".repeat(ruleLen)}</Text>
    </Box>
  );
}

export function SubagentPanel({ subagentId, dataSource }: SubagentPanelProps): React.JSX.Element {
  const [turns, setTurns] = useState<CompletedTurn[]>([]);
  const [streamText, setStreamText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskInput, setTaskInput] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxHandle>(null);
  const callbacks = useContext(CallbacksContext);

  useScrollKeys(scrollRef, !loading);

  const scrollToBottom = useCallback(() => {
    queueMicrotask(() => {
      const h = scrollRef.current;
      if (h && h.isSticky()) h.scrollToBottom();
    });
  }, []);

  // Shared dispatch helpers — same logic as app.tsx but scoped to this panel
  const pushMessage = useCallback((msg: RendererMessage) => {
    setTurns(prev => {
      const last = prev[prev.length - 1];
      if (last && last._draft) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, messages: [...last.messages, msg] };
        return updated;
      }
      return [...prev, { agent: msg.agent || subagentId, messages: [msg], timestamp: Date.now(), _draft: true }];
    });
    scrollToBottom();
  }, [subagentId, scrollToBottom]);

  const updateMessage = useCallback((callId: string, msg: RendererMessage) => {
    setTurns(prev => {
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
  }, []);

  const commitTurn = useCallback((turn: CompletedTurn) => {
    const resolved = turn.agent ? turn : { ...turn, agent: subagentId };
    setTurns(prev => {
      const last = prev[prev.length - 1];
      if (last && last._draft) {
        const updated = [...prev];
        updated[updated.length - 1] = resolved;
        return updated;
      }
      return [...prev, resolved];
    });
    scrollToBottom();
  }, [subagentId, scrollToBottom]);

  // Phase 1: replay persisted events
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await dataSource.fetchAllEvents(subagentId);
        if (cancelled) return;
        if (raw) {
          const events = parseEventLines(raw);
          const task = extractTaskContent(events);
          if (task) setTaskInput(task);
          const replayTurns: CompletedTurn[] = [];
          const acc = new TurnAccumulator({ onTurn: (t) => replayTurns.push(t) }, subagentId);
          for (const ev of events) acc.feed(ev);
          acc.flush();
          setTurns(replayTurns);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error)?.message ?? "Failed to load");
      }
      if (!cancelled) {
        setLoading(false);
        scrollToBottom();
      }
    })();
    return () => { cancelled = true; };
  }, [subagentId, dataSource, scrollToBottom]);

  // Phase 2: live event subscription (starts after replay completes)
  useEffect(() => {
    if (loading || !callbacks) return;

    const acc = new TurnAccumulator({
      onTurn:          commitTurn,
      onMessage:       pushMessage,
      onUpdateMessage: updateMessage,
      onStreamText:    (t) => setStreamText(prev => prev + t),
      onResetStreaming: () => setStreamText(""),
    }, subagentId);

    const unsub = callbacks.observeEvents((event, emitterId) => {
      if (emitterId !== subagentId && (event as Record<string, unknown>).to !== subagentId) return;
      if (event.type === "subagent_task" && !taskInput) {
        const p = (event.payload ?? {}) as Record<string, unknown>;
        const content = p.content;
        if (typeof content === "string" && content) setTaskInput(content);
      }
      acc.feed(toStoredEvent(event, emitterId));
    });
    return unsub;
  }, [loading, callbacks, subagentId, commitTurn, pushMessage, updateMessage, taskInput]);

  if (loading) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Spinner label={`Loading ${subagentId}...`} />
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.error.color}>{error}</Text>
      </Box>
    );
  }

  return (
    <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" stickyScroll={true}>
      {taskInput && (
        <Box flexDirection="column">
          <SectionDivider label="任务输入" color={theme.board.headerColor} />
          <Box paddingLeft={2} flexDirection="column" marginTop={1}>
            <Markdown>{taskInput}</Markdown>
          </Box>
        </Box>
      )}
      {turns.length > 0 && (
        <SectionDivider label="执行过程" color={theme.agentLabel.color} />
      )}
      {turns.map((turn, i) => {
        const agent = turn.agent || "";
        const isAgentTurn = agent !== "" && agent !== "user";
        const prevAgent = i > 0 ? turns[i - 1]!.agent : undefined;
        const agentChanged = isAgentTurn && agent !== (prevAgent || "");
        return (
          <Box key={i} flexDirection="column">
            {agentChanged && (
              <Box marginTop={i === 0 ? 0 : 1}>
                <Text color={theme.agentLabel.color} bold>{theme.agentLabel.char} [{agent}]</Text>
              </Box>
            )}
            {turn.messages.map((msg, j) => (
              <MessageRow key={j} msg={msg} />
            ))}
          </Box>
        );
      })}
      {streamText ? <StreamingMarkdown text={streamText} /> : null}
      <Box flexGrow={1} />
    </ScrollBox>
  );
}
