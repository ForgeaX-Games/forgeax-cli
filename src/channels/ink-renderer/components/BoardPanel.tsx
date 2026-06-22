/**
 * BoardPanel — fullscreen overlay for the /board command.
 * Shows the active agent's TeamBoard variables and agent.json configuration preview.
 */

import React, { useState, useEffect, useContext, useRef, useCallback } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { default as ScrollBox, type ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { DataSourceContext } from "../lib/contexts.js";
import { useScrollKeys } from "../hooks/use-scroll-keys.js";
import { theme } from "../lib/theme.js";

interface BoardPanelProps {
  agentId: string;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <Box marginTop={1} marginBottom={0}>
      <Text bold color={theme.board.headerColor}>{`${theme.board.headerRule}${theme.board.headerRule}${theme.board.headerRule} `}{title}{" "}</Text>
      <Text color={theme.board.ruleColor}>{theme.board.headerRule.repeat(40)}</Text>
    </Box>
  );
}

function VarsTable({ vars }: { vars: Record<string, unknown> }): React.JSX.Element {
  const entries = Object.entries(vars);
  if (entries.length === 0) {
    return <Text dimColor>  (no variables)</Text>;
  }
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return (
    <Box flexDirection="column">
      {entries.map(([key, val]) => {
        const display = formatValue(val);
        const truncated = display.length > 120 ? display.slice(0, 117) + "..." : display;
        return (
          <Box key={key}>
            <Text color={theme.board.keyColor}>{("  " + key).padEnd(maxKeyLen + 4)}</Text>
            <Text>{truncated}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function JsonPreview({ data }: { data: Record<string, unknown> }): React.JSX.Element {
  const lines = JSON.stringify(data, null, 2).split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;
        const indentStr = " ".repeat(indent + 2);

        if (trimmed.startsWith("\"") && trimmed.includes(":")) {
          const colonIdx = trimmed.indexOf(":");
          const key = trimmed.slice(0, colonIdx + 1);
          const rest = trimmed.slice(colonIdx + 1);
          return (
            <Box key={i}>
              <Text>{indentStr}</Text>
              <Text color={theme.board.jsonKeyColor}>{key}</Text>
              <Text>{rest}</Text>
            </Box>
          );
        }
        return (
          <Box key={i}>
            <Text>{indentStr}{trimmed}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function BoardPanel({ agentId }: BoardPanelProps): React.JSX.Element {
  const ds = useContext(DataSourceContext);
  const [vars, setVars] = useState<Record<string, unknown> | null>(null);
  const [agentJson, setAgentJson] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxHandle>(null);

  useScrollKeys(scrollRef, !loading);

  const load = useCallback(async () => {
    if (!ds?.fetchTeamBoard || !ds?.fetchAgentJson) {
      setError("DataSource does not support teamboard/agent-json queries");
      setLoading(false);
      return;
    }
    try {
      const [board, json] = await Promise.all([
        ds.fetchTeamBoard(agentId),
        ds.fetchAgentJson(agentId),
      ]);
      setVars(board[agentId] ?? {});
      setAgentJson(json);
    } catch (err) {
      setError((err as Error)?.message ?? "Failed to load board data");
    }
    setLoading(false);
  }, [ds, agentId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text color={theme.overlay.loadingColor}>Loading board for {agentId}...</Text>
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
    <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column">
      <SectionHeader title={`TeamBoard Variables — ${agentId}`} />
      {vars ? <VarsTable vars={vars} /> : <Text dimColor>  (unavailable)</Text>}

      <SectionHeader title="agent.json Configuration" />
      {agentJson ? (
        <JsonPreview data={agentJson} />
      ) : (
        <Text dimColor>  (no agent.json available)</Text>
      )}
      <Box marginTop={1} />
    </ScrollBox>
  );
}
