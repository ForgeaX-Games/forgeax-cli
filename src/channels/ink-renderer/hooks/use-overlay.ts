/**
 * Overlay helpers — builds OverlayRequest objects for the scheduler.
 *
 * Core pickers (agent) live here.
 * Instance lifecycle and operational flows are in overlay-flows/.
 */

import React, { useCallback, useRef } from "react";
import type { RendererDataSource, CompletedTurn, OverlayLayout } from "../types.js";
import type { OverlaySchedulerResult } from "./use-overlay-scheduler.js";
import type { OverlayFlowDeps } from "./overlay-flows/types.js";
import { AgentTreePicker } from "../components/AgentTreePicker.js";
import { appendSystemTurn } from "../lib/system-message.js";
import { pushConfirm } from "./overlay-flows/helpers.js";
import {
  showInstancePicker as instancePickerFlow,
  showDeleteInstancePicker as deleteInstanceFlow,
  showLoadPack as loadPackFlow,
  showLoadPackForInstance as loadPackForInstanceFlow,
  showTeamRestore as teamRestoreFlow,
} from "./overlay-flows/instance.js";
import {
  showPackCleanImage as packCleanImageFlow,
  showRemoveContainers as removeContainersFlow,
  showSyncPack as syncPackFlow,
} from "./overlay-flows/ops.js";

export interface UseOverlayHelpersResult {
  showInstancePicker: () => void;
  showAgentPicker: (layout?: OverlayLayout) => void;
  showDeleteCurrentAgent: () => void;
  showDeleteInstancePicker: () => void;
  showPackCleanImage: () => void;
  showRemoveContainers: () => void;
  showSyncPack: () => void;
  showLoadPack: () => void;
  showLoadPackForInstance: (instanceId: string) => void;
  showTeamRestore: () => void;
}

interface UseOverlayHelpersOptions {
  scheduler: OverlaySchedulerResult;
  dataSource: RendererDataSource;
  activeAgent: string;
  setActiveAgent: (agent: string) => void;
  setCompletedTurns: React.Dispatch<React.SetStateAction<CompletedTurn[]>>;
  setInstanceId?: (id: string) => void;
  replaySession: (agentId: string) => Promise<void>;
  instanceId: string;
  scrollToBottom: () => void;
}

export function useOverlayHelpers({
  scheduler,
  dataSource,
  activeAgent,
  setActiveAgent,
  setCompletedTurns,
  setInstanceId,
  replaySession,
  instanceId,
  scrollToBottom,
}: UseOverlayHelpersOptions): UseOverlayHelpersResult {
  const activeAgentRef = useRef(activeAgent);
  activeAgentRef.current = activeAgent;

  const instanceIdRef = useRef(instanceId);
  instanceIdRef.current = instanceId;

  // ── Shared pushSystemMessage ──

  const pushSystemMessage = useCallback((text: string) => {
    appendSystemTurn(setCompletedTurns, text, scrollToBottom);
  }, [setCompletedTurns, scrollToBottom]);

  // ── Flow deps (shared context for all overlay-flow functions) ──

  const depsRef = useRef<OverlayFlowDeps>({ scheduler, dataSource, pushSystemMessage, instanceIdRef, handleInstanceSwitch: setInstanceId });
  depsRef.current = { scheduler, dataSource, pushSystemMessage, instanceIdRef, handleInstanceSwitch: setInstanceId };

  // ── Core pickers (agent) ──

  // `/agents` opens a tree-shaped picker — replacement for the old flat
  // `/agents` select picker AND the read-only `/tree` panel. Cursor lands on
  // the currently active (cached) agent; ↑↓ moves; Enter switches; Esc is
  // handled by PanelOverlay. AgentTreePicker self-polls for live tree state.
  const showAgentPicker = useCallback((layout?: OverlayLayout) => {
    scheduler.push({
      id: "agent-picker",
      kind: "panel",
      layout: layout ?? "fullscreen",
      title: "选择 Agent",
      render: (close) => React.createElement(AgentTreePicker, {
        initialAgent: activeAgentRef.current,
        onSelect: (agentId: string) => {
          setActiveAgent(agentId);
          setCompletedTurns([]);
          replaySession(agentId).catch(() => {});
          const instId = instanceIdRef.current;
          if (instId) {
            dataSource.writeCachedAgent?.(instId, agentId).catch(() => {});
          }
          close();
        },
      }),
    });
  }, [scheduler, dataSource, setActiveAgent, setCompletedTurns, replaySession]);

  // ── Delete current agent (single-step confirm; no picker) ──
  //
  // `/delete-agent` removes the **currently active** agent, mirroring the
  // backend `free_agent` tool but driven from the renderer slash UI. After
  // free completes we reset activeAgent + cached selection so startup-flow's
  // useEffect (Condition 2) takes over and waterfalls into the agent picker
  // — no separate "post-delete picker" is needed here.
  const showDeleteCurrentAgent = useCallback(() => {
    const agentId = activeAgentRef.current;
    if (!agentId) {
      pushSystemMessage("当前没有选中 Agent，无法 /delete-agent。");
      return;
    }
    if (!dataSource.freeAgent) {
      pushSystemMessage("当前 dataSource 不支持 /delete-agent（需要 Gateway 通道）。");
      return;
    }
    pushConfirm(scheduler, {
      id: "delete-agent-confirm",
      title: `确认删除当前 Agent "${agentId}"？（不可恢复）`,
      confirmLabel: "确认删除（不可恢复）",
      confirmHint: "agents/ + homes/ 全删，孩子提升为 root",
      onConfirm: () => {
        const instId = instanceIdRef.current;
        scheduler.clear();
        // Optimistically clear the active agent + cached selection so startup-flow
        // doesn't try to re-select the agent we're about to remove. The runtime
        // free is fire-and-forget at the UI layer; errors are surfaced as
        // system messages but the picker still opens.
        dataSource.writeCachedAgent?.(instId, "").catch(() => {});
        setActiveAgent("");
        setCompletedTurns([]);
        dataSource.freeAgent!(instId, agentId)
          .then(() => pushSystemMessage(`🗑  Agent "${agentId}" 已删除。请选择下一个 Agent。`))
          .catch((e) => pushSystemMessage(`❌ 删除 Agent 失败: ${e instanceof Error ? e.message : String(e)}`));
      },
    });
  }, [scheduler, dataSource, setActiveAgent, setCompletedTurns, pushSystemMessage]);

  // ── Delegated flows ──

  const showInstancePicker = useCallback(() => {
    instancePickerFlow(depsRef.current, setInstanceId);
  }, [setInstanceId]);

  const showDeleteInstancePicker = useCallback(() => {
    deleteInstanceFlow(depsRef.current);
  }, []);

  const showPackCleanImage = useCallback(() => {
    packCleanImageFlow(depsRef.current);
  }, []);

  const showRemoveContainers = useCallback(() => {
    removeContainersFlow(depsRef.current);
  }, []);

  const showSyncPack = useCallback(() => {
    syncPackFlow(depsRef.current);
  }, []);

  const showLoadPack = useCallback(() => {
    loadPackFlow(depsRef.current);
  }, []);

  const showLoadPackForInstance = useCallback((instId: string) => {
    loadPackForInstanceFlow(depsRef.current, instId);
  }, []);

  const showTeamRestore = useCallback(() => {
    teamRestoreFlow(depsRef.current);
  }, []);

  return {
    showInstancePicker, showAgentPicker, showDeleteCurrentAgent,
    showDeleteInstancePicker, showPackCleanImage, showRemoveContainers,
    showSyncPack, showLoadPack, showLoadPackForInstance, showTeamRestore,
  };
}
