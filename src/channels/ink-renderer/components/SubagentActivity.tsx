/**
 * SubagentActivity — clickable box for subagent tool calls.
 * Extracted from MessageRow to keep rendering concerns modular.
 */

import React, { useState, useContext, useCallback, useEffect } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import type { ToolCallMessage } from "../types.js";
import { TOOL_STATE_ICON } from "../lib/figures.js";
import { theme } from "../lib/theme.js";
import { OverlaySchedulerContext, DataSourceContext } from "../lib/contexts.js";
import { SubagentPanel } from "./SubagentPanel.js";

function Spinner(): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % theme.spinner.frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Box>
      <Text color={theme.spinner.color}>{theme.spinner.frames[frame]} </Text>
    </Box>
  );
}

const CONTENT_TRUNCATE = 120;

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function SubagentActivity({ msg, indent }: { msg: ToolCallMessage; indent?: boolean }) {
  const pad = indent ? 2 : 0;
  const scheduler = useContext(OverlaySchedulerContext);
  const dataSource = useContext(DataSourceContext);
  const status = msg.status ?? "running";
  const isDone = status === "done" || status === "error";
  const durationLabel = formatDuration(msg.durationMs);
  const resultDisplay = msg.resultDisplay ?? msg.resultContent;
  const subagentId = msg.subagentId;

  const args = (msg.args ?? {}) as Record<string, unknown>;
  const task = String(args.task ?? "").slice(0, CONTENT_TRUNCATE);
  const type = String(args.type ?? "");

  const openOverlay = useCallback(() => {
    if (!scheduler || !dataSource || !subagentId) return;
    scheduler.push({
      id: `subagent-panel-${subagentId}`,
      kind: "panel",
      layout: "fullscreen",
      title: `Subagent: ${type} — ${task.slice(0, 60)}`,
      render: (close) => <SubagentPanel subagentId={subagentId} dataSource={dataSource} />,
    });
  }, [scheduler, dataSource, subagentId, type, task]);

  const statusIcon = status === "running"
    ? <Spinner />
    : <Text color={status === "error" ? theme.toolError.color : theme.toolDone.color}>
        {TOOL_STATE_ICON[status === "error" ? "error" : "done"]}{" "}
      </Text>;

  const borderColor = status === "running"
    ? theme.subagent.activeBorder
    : status === "error"
      ? theme.toolError.color
      : theme.subagent.doneBorder;

  const contentText = isDone
    ? String(resultDisplay ?? "").slice(0, CONTENT_TRUNCATE)
    : task;

  return (
    <Box flexDirection="column" paddingLeft={pad + 2} width="100%">
      <Box
        borderStyle={theme.subagent.borderStyle}
        borderColor={borderColor}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        onClick={subagentId ? openOverlay : undefined}
      >
        <Box>
          {statusIcon}
          <Text bold color={theme.subagent.color}>subagent</Text>
          <Text dimColor> ({type})</Text>
          {isDone && durationLabel ? <Text dimColor> {durationLabel}</Text> : null}
        </Box>
        <Box paddingLeft={2}>
          <Text>{contentText}</Text>
        </Box>
        {subagentId ? (
          <Box paddingLeft={2}>
            <Text dimColor italic>点击查看详情</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
