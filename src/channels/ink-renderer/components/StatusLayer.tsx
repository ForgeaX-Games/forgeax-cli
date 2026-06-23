/**
 * StatusLayer — single-line status bar: spinner + agent label + elapsed/tokens + context bar.
 * Layout: ⠋ agent:admin (1m 23s · ↓ 1.4k tokens) ▕████░░░░▏  45%
 */

import React, { useState, useEffect, useRef } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { theme } from "../lib/theme.js";
import { useSpinnerFrame } from "../lib/animation-clock.js";

/** Animate upward with ease-out; snap immediately on decrease. */
function useAnimatedNumber(target: number, durationMs = 1500): number {
  const [displayed, setDisplayed] = useState(target);
  const ref = useRef({ displayed: target, to: target });

  useEffect(() => {
    if (target === ref.current.to && target === ref.current.displayed) {
      return;
    }

    const from = ref.current.displayed;
    if (target < from) {
      ref.current = { displayed: target, to: target };
      setDisplayed(target);
      return;
    }

    if (from === target) {
      ref.current = { displayed: target, to: target };
      setDisplayed(target);
      return;
    }

    ref.current.to = target;
    const start = Date.now();

    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / durationMs);
      const eased = 1 - (1 - p) ** 3;
      const v = Math.round(from + (target - from) * eased);
      ref.current.displayed = v;
      setDisplayed(v);
      if (p < 1) timer = setTimeout(tick, 32);
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [target, durationMs]);

  return displayed;
}

interface StatusLayerProps {
  agent: string;
  thinking: boolean;
  contextPct?: number;
  agentStatus?: string;
  thinkingStartMs?: number;
  lastCompletedTurnDurationMs?: number;
  turnTokens?: number;
}

const BAR_WIDTH = 8;
const TURN_COMPLETION_SHOW_AFTER_MS = 2 * 60 * 1000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function ContextBar({ pct }: { pct: number }): React.JSX.Element {
  const ratio = Math.min(100, Math.max(0, pct)) / 100;
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const label = `${pct}%`.padStart(4);

  const color = pct >= 90 ? theme.contextRing.critical
    : pct >= 70 ? theme.contextRing.high
    : pct >= 50 ? theme.contextRing.medium
    : theme.contextRing.low;

  return (
    <>
      <Text dimColor>{theme.statusBar.bar.left}</Text>
      <Text color={color}>{theme.statusBar.bar.full.repeat(filled)}</Text>
      <Text dimColor>{theme.statusBar.bar.empty.repeat(empty)}{theme.statusBar.bar.right} {label}</Text>
    </>
  );
}

function InlineSpinner(): React.JSX.Element {
  const frame = useSpinnerFrame(theme.spinner.frames.length);
  return <Text color={theme.spinner.color}>{theme.spinner.frames[frame]}</Text>;
}

function ElapsedTimer({ startMs }: { startMs: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <Text dimColor>{formatElapsed(now - startMs)}</Text>;
}

function TurnCompletionMeta({ durationMs }: { durationMs: number }): React.JSX.Element | null {
  if (durationMs < TURN_COMPLETION_SHOW_AFTER_MS) return null;
  return <Text dimColor>  ✦ Worked for {formatElapsed(durationMs)}</Text>;
}

export function StatusLayer({
  agent,
  thinking,
  contextPct,
  agentStatus,
  thinkingStartMs,
  lastCompletedTurnDurationMs,
  turnTokens,
}: StatusLayerProps): React.JSX.Element {
  const showMeta = thinking && thinkingStartMs != null && thinkingStartMs > 0;
  const animatedTokens = useAnimatedNumber(turnTokens ?? 0);
  const showCompletionMeta = !thinking && (lastCompletedTurnDurationMs ?? 0) > 0;

  return (
    <Box width="100%" height={1} flexShrink={0} overflowY="hidden">
      <Box flexShrink={1} flexGrow={1} overflow="hidden">
        <Text wrap="truncate">
          {thinking
            ? <InlineSpinner />
            : <Text color={theme.agentLabel.color}>{theme.agentLabel.char}</Text>}
          <Text> </Text>
          <Text bold color={theme.agentLabel.color}>agent:{agent || theme.statusBar.noValue}</Text>
          {showMeta && (
            <>
              <Text dimColor> (</Text>
              <ElapsedTimer startMs={thinkingStartMs!} />
              {animatedTokens > 0 && (
                <>
                  <Text dimColor> · ↓ </Text>
                  <Text dimColor>{formatTokens(animatedTokens)} tokens</Text>
                </>
              )}
              <Text dimColor>)</Text>
            </>
          )}
          {showCompletionMeta && (
            <TurnCompletionMeta durationMs={lastCompletedTurnDurationMs!} />
          )}
          <Text> </Text>
          {contextPct != null && contextPct > 0
            ? <ContextBar pct={contextPct} />
            : <Text dimColor>{theme.statusBar.bar.left}{theme.statusBar.bar.empty.repeat(BAR_WIDTH)}{theme.statusBar.bar.right}   {theme.statusBar.noValue}%</Text>}
        </Text>
      </Box>
      {agentStatus ? (
        <Box flexShrink={0} marginLeft={1}>
          <Text bold color="rgb(255,165,0)">{agentStatus}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
