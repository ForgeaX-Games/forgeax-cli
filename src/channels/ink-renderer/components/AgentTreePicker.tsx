/**
 * AgentTreePicker — fullscreen overlay for the /agents command.
 *
 * Merged successor of the old /agents (flat select picker) + /tree (read-only
 * tree view) commands. Renders the agent tree with role badges and running
 * indicators (TreePanel's visual), plus:
 *
 *   - keyboard ↑↓ navigation through a pre-order flattening of the tree
 *   - cursor lands on `initialAgent` (the cached selection) at first paint
 *   - Enter calls onSelect(agentId); ESC is handled by the wrapping
 *     PanelOverlay (single source for cancel)
 *   - live state polling (default 2 s) — running flags / new children show
 *     up without re-opening the picker, mirroring the instance overlay UX
 *
 * Why pre-order flattening: the row list mapping makes cursor math O(1),
 * survives polling-induced reorders by tracking selectedAgent (id), not
 * idx. If selectedAgent disappears (deleted externally), cursor falls
 * back to row 0.
 */

import React, { useState, useEffect, useContext, useMemo, useRef, useCallback } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { DataSourceContext } from "../lib/contexts.js";
import { theme } from "../lib/theme.js";
import type { AgentNodeData } from "../../../core/types.js";

interface TreeNode extends AgentNodeData {
  children: TreeNode[];
  running: boolean;
}

interface FlatRow {
  node: TreeNode;
  prefix: string;
  isLast: boolean;
  isRoot: boolean;
}

interface AgentTreePickerProps {
  initialAgent: string;
  onSelect: (agentId: string) => void;
  /** Re-fetch tree + teamboard at this interval (ms). 0 disables polling. */
  pollMs?: number;
}

const ROLE_COLOR = theme.tree.roleColor;
const DEFAULT_POLL_MS = 2000;

function buildTree(
  nodes: AgentNodeData[],
  runningMap: Record<string, boolean>,
): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const n of nodes) {
    map.set(n.id, { ...n, children: [], running: !!runningMap[n.id] });
  }
  const roots: TreeNode[] = [];
  for (const n of map.values()) {
    if (n.parentId && map.has(n.parentId)) {
      map.get(n.parentId)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  return roots;
}

function flattenTree(roots: TreeNode[]): FlatRow[] {
  const conn = theme.tree.connectors;
  const out: FlatRow[] = [];
  function visit(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): void {
    out.push({ node, prefix, isLast, isRoot });
    const childPrefix = isRoot ? "" : prefix + (isLast ? conn.blank : conn.pipe);
    for (let i = 0; i < node.children.length; i++) {
      visit(node.children[i]!, childPrefix, i === node.children.length - 1, false);
    }
  }
  for (let i = 0; i < roots.length; i++) {
    visit(roots[i]!, "", i === roots.length - 1, true);
  }
  return out;
}

function TreeRow({ row, selected }: { row: FlatRow; selected: boolean }): React.JSX.Element {
  const conn = theme.tree.connectors;
  const { node, prefix, isLast, isRoot } = row;
  const connector = isRoot ? "" : isLast ? conn.last : conn.mid;
  const roleColor = ROLE_COLOR[node.role] ?? theme.tree.roleColor.worker;
  const statusIcon = node.running ? theme.tree.runningIcon : theme.tree.stoppedIcon;
  const statusColor = node.running ? theme.tree.runningColor : theme.tree.stoppedColor;

  return (
    <Box>
      <Text color={selected ? theme.overlay.selectedColor : undefined} bold={selected}>
        {selected ? `${theme.overlay.selectedChar} ` : "  "}
      </Text>
      <Text>{prefix}{connector}</Text>
      <Text color={statusColor}>{statusIcon} </Text>
      <Text bold={selected} color={selected ? theme.overlay.selectedColor : undefined}>{node.id}</Text>
      <Text color={roleColor}> [{node.role}]</Text>
      {node.running ? <Text color={theme.tree.runningColor}> running</Text> : null}
    </Box>
  );
}

export function AgentTreePicker({
  initialAgent,
  onSelect,
  pollMs = DEFAULT_POLL_MS,
}: AgentTreePickerProps): React.JSX.Element {
  const ds = useContext(DataSourceContext);
  const [nodes, setNodes] = useState<AgentNodeData[]>([]);
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>(initialAgent);
  const [confirming, setConfirming] = useState(false);

  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const load = useCallback(async () => {
    if (!ds?.fetchAgentTree || !ds?.fetchTeamBoard) {
      if (aliveRef.current) {
        setError("DataSource does not support tree/teamboard queries");
        setLoading(false);
      }
      return;
    }
    try {
      const [fetchedNodes, board] = await Promise.all([
        ds.fetchAgentTree(),
        ds.fetchTeamBoard(),
      ]);
      if (!aliveRef.current) return;
      const next: Record<string, boolean> = {};
      for (const [agentId, vars] of Object.entries(board)) {
        next[agentId] = vars.RUNNING === true;
      }
      setNodes(fetchedNodes);
      setRunningMap(next);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!aliveRef.current) return;
      setError((err as Error)?.message ?? "Failed to load agent tree");
      setLoading(false);
    }
  }, [ds]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const t = setInterval(() => { load(); }, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  const flatRows = useMemo(() => flattenTree(buildTree(nodes, runningMap)), [nodes, runningMap]);

  // Resolve cursor index from selectedAgent. If the agent disappeared (e.g.
  // deleted externally during the picker session), fall back to row 0.
  const cursorIdx = useMemo(() => {
    if (flatRows.length === 0) return -1;
    const found = flatRows.findIndex(r => r.node.id === selectedAgent);
    return found >= 0 ? found : 0;
  }, [flatRows, selectedAgent]);

  // First-paint cursor sync: once flatRows arrives, snap selectedAgent onto
  // the resolved row in case `initialAgent` wasn't in the tree.
  useEffect(() => {
    if (flatRows.length > 0 && cursorIdx >= 0 && flatRows[cursorIdx]!.node.id !== selectedAgent) {
      setSelectedAgent(flatRows[cursorIdx]!.node.id);
    }
  }, [flatRows, cursorIdx, selectedAgent]);

  useInput((_input, key) => {
    if (loading || confirming || flatRows.length === 0) return;
    // ESC is handled by the wrapping PanelOverlay — do not double-handle here.
    if (key.upArrow) {
      const next = Math.max(0, cursorIdx - 1);
      setSelectedAgent(flatRows[next]!.node.id);
      return;
    }
    if (key.downArrow) {
      const next = Math.min(flatRows.length - 1, cursorIdx + 1);
      setSelectedAgent(flatRows[next]!.node.id);
      return;
    }
    if (key.return) {
      const target = flatRows[cursorIdx]?.node.id;
      if (!target) return;
      setConfirming(true);
      onSelect(target);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text color={theme.overlay.loadingColor}>Loading agent tree...</Text>
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

  if (flatRows.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>No agents found.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {flatRows.map((row, i) => (
        <TreeRow key={row.node.id} row={row} selected={i === cursorIdx} />
      ))}
      <Box marginTop={1}>
        {confirming ? (
          <Text color={theme.overlay.loadingColor}>切换中...</Text>
        ) : (
          <Text dimColor>↑↓ 移动  Enter 切换  Esc 关闭</Text>
        )}
      </Box>
    </Box>
  );
}
