/**
 * MessageRow — renders a single RendererMessage.
 *
 * Four rendering patterns:
 *   1. UserPrompt     — background strip for real user input
 *   2. AssistantContent — ● prefix + collapsible thinking + markdown
 *   3. ToolActivity   — status icon + tool name + sub-rows (call & result unified)
 *   4. SystemLine     — dim icon + label + text (tick, notice, external, command, etc.)
 */

import React, { memo, useContext } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { Ansi } from "../ink/Ansi.js";
import { Markdown } from "../ink/components/StreamingMarkdown.js";
import type { RendererMessage } from "../types.js";
import { TOOL_STATE_ICON, BLOCKQUOTE_BAR, THINKING_SYMBOL } from "../lib/figures.js";
import { theme } from "../lib/theme.js";
import { ColumnsContext } from "../lib/contexts.js";
import { useSpinnerFrame, useBlinkVisible } from "../lib/animation-clock.js";
import { Collapsible } from "./Collapsible.js";
import { SubagentActivity } from "./SubagentActivity.js";
import { ToolResultRow } from "./ToolResultRow.js";

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ── Dispatch ──

export const MessageRow = memo(function MessageRow({ msg, indent }: { msg: RendererMessage; indent?: boolean }): React.JSX.Element | null {
  switch (msg.kind) {
    case "user_input":
      if (msg.isSteer) return <SteerLine text={msg.text} />;
      return <UserPrompt text={msg.text} />;
    case "assistant_complete":
      return <AssistantContent thinking={msg.thinking} text={msg.text} indent={indent} />;
    case "tool_call":
      return <ToolActivity msg={msg} indent={indent} />;
    case "tool_result":
      return <ToolResultFallback msg={msg} indent={indent} />;
    case "system":
      return <SystemLine source={msg.source} text={msg.text} visualDisplay={msg.visualDisplay} level={msg.level} direction={msg.direction} from={msg.from} to={msg.to} />;
    default:
      return null;
  }
});

// ── 1. UserPrompt / SteerLine ──

function SteerLine({ text }: { text: string }) {
  return (
    <Box backgroundColor={theme.userMessage.bg} paddingRight={1} marginTop={1} width="100%">
      <Text color={theme.steerInput.color} bold>{theme.steerInput.char} </Text>
      <Text color={theme.userMessage.fg}>{text}</Text>
    </Box>
  );
}

function UserPrompt({ text }: { text: string }) {
  return (
    <Box backgroundColor={theme.userMessage.bg} paddingRight={1} marginTop={1} width="100%">
      <Text color={theme.userInput.color} bold>{theme.userInput.promptChar} </Text>
      <Text color={theme.userMessage.fg}>{text}</Text>
    </Box>
  );
}

// ── 2. AssistantContent ──

function AssistantContent({ thinking, text, indent }: { thinking?: string; text?: string; indent?: boolean }) {
  const pad = indent ? 2 : 0;
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      {thinking ? <CollapsibleThinking thinking={thinking} indent={indent} /> : null}
      {text ? (
        <Box flexDirection="row" width="100%" paddingLeft={pad}>
          <Box flexShrink={0} minWidth={2}><Text color={theme.agentLabel.color}>{theme.agentLabel.char}</Text></Box>
          <Box flexShrink={1} flexGrow={1} flexDirection="column"><Markdown>{text}</Markdown></Box>
        </Box>
      ) : null}
    </Box>
  );
}

function CollapsibleThinking({ thinking, indent }: { thinking: string; indent?: boolean }) {
  const columns = useContext(ColumnsContext);
  const pad = indent ? 2 : 0;
  const lines = thinking.split("\n");
  const headerLen = `${THINKING_SYMBOL} Thinking `.length;
  const ruleLen = Math.max(0, columns - headerLen - 4 - pad);

  const collapsedSummary = (
    <Box paddingLeft={pad + 2}>
      <Text color={theme.thinking.symbolColor} italic>{THINKING_SYMBOL} </Text>
      <Text dimColor italic>Thinking </Text>
      <Text dimColor>(click to expand)</Text>
    </Box>
  );

  const expandedSummary = (
    <Box paddingLeft={pad + 2}>
      <Text color={theme.thinking.symbolColor} italic>{THINKING_SYMBOL} </Text>
      <Text dimColor italic>Thinking </Text>
      <Text dimColor>{theme.thinking.ruleChar.repeat(ruleLen)}</Text>
    </Box>
  );

  return (
    <Collapsible summary={expandedSummary} collapsedSummary={collapsedSummary}>
      <Box flexDirection="column" paddingLeft={pad + 2}>
        {lines.map((line, i) => (
          <Box key={i}>
            <Text color={theme.thinking.barColor}>{BLOCKQUOTE_BAR} </Text>
            <Text color={theme.thinking.textColor} italic>{line}</Text>
          </Box>
        ))}
      </Box>
    </Collapsible>
  );
}

// ── 3. ToolActivity ──

const TOOL_STATUS_STYLE = {
  pending: { icon: TOOL_STATE_ICON.pending, color: theme.toolPending.color, blink: false },
  running: { icon: TOOL_STATE_ICON.running, color: theme.toolRunning.color, blink: true },
  done:    { icon: TOOL_STATE_ICON.done,    color: theme.toolDone.color,    blink: false },
  error:   { icon: TOOL_STATE_ICON.error,   color: theme.toolError.color,   blink: false },
} as const;

function BlinkingIcon({ icon, color }: { icon: string; color: string }) {
  const visible = useBlinkVisible();
  return <Text color={color}>{visible ? icon : " "} </Text>;
}

function ToolStatusIcon({ status }: { status: string }) {
  const style = TOOL_STATUS_STYLE[status as keyof typeof TOOL_STATUS_STYLE] ?? TOOL_STATUS_STYLE.running;
  if (style.blink) return <BlinkingIcon icon={style.icon} color={style.color} />;
  return <Text color={style.color}>{style.icon} </Text>;
}

// ── Args formatting utilities ──

const HIDDEN_ARG_KEYS = new Set(["contents", "new_string", "old_string", "content", "body", "edits"]);
const ARG_VALUE_TRUNCATE = 120;

function formatArgs(args: unknown): Array<{ key: string; value: string }> {
  if (!args || typeof args !== "object") return [];
  const entries = Object.entries(args as Record<string, unknown>);
  return entries
    .filter(([k, v]) => v != null && !HIDDEN_ARG_KEYS.has(k))
    .map(([k, v]) => {
      const s = typeof v === "string" ? v
        : typeof v === "boolean" || typeof v === "number" ? String(v)
        : JSON.stringify(v) ?? "";
      const display = s.length > ARG_VALUE_TRUNCATE
        ? s.slice(0, ARG_VALUE_TRUNCATE - 3) + "..."
        : s;
      return { key: k, value: display };
    });
}

function ArgsTable({ args }: { args: unknown }): React.JSX.Element | null {
  const items = formatArgs(args);
  if (!items.length) return null;
  const maxKeyLen = Math.max(...items.map(i => i.key.length));
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {items.map(({ key, value }, i) => (
        <Box key={i}>
          <Text dimColor>{key.padEnd(maxKeyLen + 2)}</Text>
          <Text>{value}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── Generic ToolActivity ──

const VIS_TRUNCATE = 80;

function ToolActivity({ msg, indent }: { msg: Extract<RendererMessage, { kind: "tool_call" }>; indent?: boolean }) {
  const pad = indent ? 2 : 0;
  const status = msg.status ?? "running";
  const durationLabel = formatDuration(msg.durationMs);
  const isDone = status === "done" || status === "error";
  const resultDisplay = msg.resultDisplay ?? msg.resultContent;
  const vis = msg.visualDisplay ?? "";
  const visLong = vis.length > VIS_TRUNCATE;

  if (msg.name === "subagent") {
    return <SubagentActivity msg={msg} indent={indent} />;
  }

  if (msg.name === "todo_write" && isDone && resultDisplay) {
    return <TodoWriteActivity headerVis={vis} durationLabel={durationLabel} resultDisplay={resultDisplay} indent={indent} />;
  }

  if (msg.name === "shell") {
    return <ShellActivity msg={msg} indent={indent} />;
  }

  const collapsedHeader = (
    <Box width="100%">
      <Box flexShrink={0} minWidth={2}><ToolStatusIcon status={status} /></Box>
      <Text wrap="truncate">
        <Text bold>{msg.name}</Text>
        {vis ? <Text dimColor>({visLong ? vis.slice(0, VIS_TRUNCATE) + "…" : vis})</Text> : null}
        {isDone && durationLabel ? <Text dimColor> ({durationLabel})</Text> : null}
      </Text>
    </Box>
  );

  const expandedHeader = (
    <Box width="100%">
      <Box flexShrink={0} minWidth={2}><ToolStatusIcon status={status} /></Box>
      <Text wrap="truncate">
        <Text bold>{msg.name}</Text>
        {isDone && durationLabel ? <Text dimColor> ({durationLabel})</Text> : null}
      </Text>
    </Box>
  );

  const hasArgs = msg.args && typeof msg.args === "object" && Object.keys(msg.args as Record<string, unknown>).length > 0;

  return (
    <Box flexDirection="column" paddingLeft={pad + 2} width="100%">
      {hasArgs ? (
        <Collapsible
          collapsedSummary={collapsedHeader}
          summary={expandedHeader}
        >
          <ArgsTable args={msg.args} />
        </Collapsible>
      ) : collapsedHeader}
      {isDone ? (
        <ToolResultRow status={status} resultDisplay={resultDisplay} fullResult={msg.fullResultContent} />
      ) : (
        <Box><Text dimColor>  {theme.toolResult.connector} {theme.toolResult.ellipsis}</Text></Box>
      )}
    </Box>
  );
}

// ── 3a. ShellActivity — specialized shell command rendering ──

function ShellActivity({ msg, indent }: { msg: Extract<RendererMessage, { kind: "tool_call" }>; indent?: boolean }) {
  const pad = indent ? 2 : 0;
  const status = msg.status ?? "running";
  const durationLabel = formatDuration(msg.durationMs);
  const isDone = status === "done" || status === "error";
  const resultDisplay = msg.resultDisplay ?? msg.resultContent;

  const args = (msg.args ?? {}) as Record<string, unknown>;
  const command = String(args.command ?? "");
  const terminalId = args.terminal_id ? String(args.terminal_id) : undefined;
  const description = args.description ? String(args.description) : undefined;
  const first = command.split("\n")[0] ?? "";
  const cmdLabel = first ? (first.length > 80 ? first.slice(0, 77) + "..." : first) : undefined;
  const label = description ?? cmdLabel ?? (terminalId ? `wait ${terminalId}` : "");
  const showCommandExpander = command && command !== label;

  const headerRow = (
    <Box width="100%">
      <Box flexShrink={0} minWidth={2}><ToolStatusIcon status={status} /></Box>
      <Text wrap="truncate">
        <Text bold color="green">$ </Text>
        <Text bold>{label}</Text>
        {isDone && durationLabel ? <Text dimColor> ({durationLabel})</Text> : null}
      </Text>
    </Box>
  );

  return (
    <Box flexDirection="column" paddingLeft={pad + 2} width="100%">
      {showCommandExpander ? (
        <Collapsible collapsedSummary={headerRow} summary={headerRow}>
          <Box paddingLeft={4} flexDirection="column">
            {command.split("\n").map((line, i) => (
              <Box key={i}><Text dimColor>{line}</Text></Box>
            ))}
          </Box>
        </Collapsible>
      ) : headerRow}
      {isDone ? (
        <ToolResultRow status={status} resultDisplay={resultDisplay} fullResult={msg.fullResultContent} />
      ) : (
        <Box><Text dimColor>  {theme.toolResult.connector} {theme.toolResult.ellipsis}</Text></Box>
      )}
    </Box>
  );
}

// ── 3b. TodoWriteActivity — always-expanded todo list ──

function TodoWriteActivity({ headerVis, durationLabel, resultDisplay, indent }: {
  headerVis: string; durationLabel: string; resultDisplay: string; indent?: boolean;
}) {
  const pad = indent ? 2 : 0;
  const lines = resultDisplay.split("\n");
  return (
    <Box flexDirection="column" paddingLeft={pad + 2} width="100%">
      <Box>
        <Box flexShrink={0} minWidth={2}><Text color={theme.toolDone.color}>{TOOL_STATE_ICON.done}</Text></Box>
        <Text bold>todo_write</Text>
        {headerVis ? <Text dimColor>({headerVis})</Text> : null}
        {durationLabel ? <Text dimColor> ({durationLabel})</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={4}>
        {lines.map((line, i) => (
          <Box key={i}><Text dimColor>{line}</Text></Box>
        ))}
      </Box>
    </Box>
  );
}

function ToolResultFallback({ msg, indent }: { msg: Extract<RendererMessage, { kind: "tool_result" }>; indent?: boolean }) {
  const pad = indent ? 2 : 0;
  const durationLabel = formatDuration(msg.durationMs);
  const isError = msg.isError || msg.content?.startsWith("Error") || msg.content?.startsWith("error");
  const resultDisplay = msg.visualDisplay ?? msg.content;

  const fallbackStatus = isError ? "error" : "done";

  return (
    <Box flexDirection="column" paddingLeft={pad + 2} width="100%">
      <Box>
        <Box flexShrink={0} minWidth={2}><ToolStatusIcon status={fallbackStatus} /></Box>
        <Text bold>{msg.name}</Text>
        {durationLabel ? <Text dimColor> ({durationLabel})</Text> : null}
      </Box>
      <ToolResultRow status={fallbackStatus} resultDisplay={resultDisplay} fullResult={msg.fullContent} />
    </Box>
  );
}

// ── 4. SystemLine ──

const SYSTEM_COLLAPSE_THRESHOLD = 200;

function SystemLine({ source, text, visualDisplay, level, direction, from, to }: {
  source: string;
  text: string;
  visualDisplay?: string;
  level?: "info" | "warning" | "error";
  direction?: "incoming" | "outgoing";
  from?: string;
  to?: string;
}) {
  if (visualDisplay) {
    const lines = visualDisplay.split("\n");
    if (lines.length === 1) {
      return (
        <Box width="100%">
          <Ansi>{visualDisplay}</Ansi>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" width="100%">
        {lines.map((line, i) => (
          <Box key={i} width="100%"><Ansi>{line}</Ansi></Box>
        ))}
      </Box>
    );
  }

  const tone = level === "error" ? theme.error : level === "warning" ? theme.warning : undefined;

  // Direction-aware visual decoration: emoji only, no verbose "from X" / "to X".
  // The formatter already bakes source into a short tag (e.g. "admin(message)"
  // for incoming, "message" for outgoing), so we just prepend the emoji.
  let directionLabel: string | null = null;
  if (direction === "incoming") {
    directionLabel = "📨";
  } else if (direction === "outgoing") {
    directionLabel = "📤";
  }

  const labelColor = tone?.color ?? theme.systemLine.labelColor;
  const labelText = directionLabel
    ? (source ? `${directionLabel} ${source}` : directionLabel)
    : source;
  const prefix = labelText
    ? <Text color={labelColor}>{tone?.icon ? `${tone.icon} ` : ""}{labelText}: </Text>
    : null;
  const isLong = text.length > SYSTEM_COLLAPSE_THRESHOLD || text.includes("\n");

  if (!isLong) {
    return (
      <Box width="100%">
        <Text color={tone?.color} dimColor={!tone}>{prefix}{text}</Text>
      </Box>
    );
  }

  const firstLine = text.split("\n")[0]!;
  const truncated = firstLine.length > SYSTEM_COLLAPSE_THRESHOLD
    ? firstLine.slice(0, SYSTEM_COLLAPSE_THRESHOLD)
    : firstLine;

  return (
    <Box flexDirection="column" width="100%">
      <Collapsible
        collapsedSummary={
          <Text color={tone?.color} dimColor={!tone}>{prefix}{truncated} <Text dimColor>(click to expand)</Text></Text>
        }
        summary={<Text color={tone?.color} dimColor={!tone}>{prefix}</Text>}
      >
        <Box paddingLeft={2} flexDirection="column" width="100%">
          {text.split("\n").map((line, i) => (
            <Box key={i} width="100%"><Text color={tone?.color} dimColor={!tone}>{line}</Text></Box>
          ))}
        </Box>
      </Collapsible>
    </Box>
  );
}

// ── Spinner (exported for reuse in streaming area) ──

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  const frame = useSpinnerFrame(theme.spinner.frames.length);
  return (
    <Box>
      <Text color={theme.spinner.color}>{theme.spinner.frames[frame]} </Text>
      {label ? <Text dimColor>{label}</Text> : null}
    </Box>
  );
}
