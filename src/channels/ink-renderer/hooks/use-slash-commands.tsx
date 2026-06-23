/**
 * useSlashCommands — maps slash-command strings to actions.
 *
 * Centralises the /agents, /instance, /tree, /board,
 * /terminal-setup routing so that app.tsx stays a pure orchestration
 * layer and doesn't grow a giant handleSlashCommand switch.
 *
 * Commands that open overlays go through the overlay scheduler;
 * unrecognised commands fall back to onUserInput.
 */

import React, { useCallback, useState } from "react";
import type { RendererCallbacks, RendererDataSource, CompletedTurn } from "../types.js";
import type { OverlaySchedulerResult } from "./use-overlay-scheduler.js";
import type { OverlayLayout } from "../types.js";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { BoardPanel } from "../components/BoardPanel.js";
import { parseCommand } from "../../../core/command-parser.js";
import { theme } from "../lib/theme.js";
import { appendSystemTurn } from "../lib/system-message.js";
import { resolveSlashCommand } from "../lib/slash-command-registry.js";
import type { CommandResult } from "../../../capability/command/types.js";
import {
  checkSetupStatus,
  installKeybindings,
  uninstallKeybindings,
  isNativeExtendedKeyTerminal,
  setDismissed,
  getKeybindingsPath,
  isRemoteSsh,
  buildManualInstallInstructions,
} from "../lib/terminal-setup.js";

interface UseSlashCommandsDeps {
  scheduler: OverlaySchedulerResult;
  callbacks: RendererCallbacks;
  dataSource: RendererDataSource;
  activeAgentRef: React.RefObject<string>;
  instanceId: string;
  showAgentPicker: (layout?: OverlayLayout) => void;
  showInstancePicker: () => void;
  showDeleteCurrentAgent: () => void;
  showDeleteInstancePicker: () => void;
  showPackCleanImage: () => void;
  showRemoveContainers: () => void;
  showSyncPack: () => void;
  showLoadPack: () => void;
  showTeamRestore: () => void;
  setCompletedTurns: React.Dispatch<React.SetStateAction<CompletedTurn[]>>;
  scrollToBottom: () => void;
}

interface ModelChainPanelProps {
  models: string[];
  initialChain: string[];
  onSave: (chain: string[]) => Promise<void>;
  onSaved: (chain: string[]) => void;
  onError: (err: unknown) => void;
}

const SAVE_ROW = "__save__";

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of list) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

function ModelChainPanel({ models, initialChain, onSave, onSaved, onError }: ModelChainPanelProps): React.JSX.Element {
  const [chain, setChain] = useState(() => dedupe(initialChain));
  const [idx, setIdx] = useState(0);
  const [saving, setSaving] = useState(false);

  // Catalog order, with any unknown models still in chain appended so user can
  // explicitly remove them. Save row sits at the bottom.
  const unknownSelected = chain.filter((m) => !models.includes(m));
  const items = [...models, ...unknownSelected, SAVE_ROW];
  const safeIdx = Math.min(idx, items.length - 1);

  useInput((_input, key) => {
    if (saving) return;
    if (key.upArrow) setIdx(cur => Math.max(0, cur - 1));
    else if (key.downArrow) setIdx(cur => Math.min(items.length - 1, cur + 1));
    else if (key.return) {
      const item = items[safeIdx];
      if (!item) return;
      if (item === SAVE_ROW) {
        if (chain.length === 0) return;
        setSaving(true);
        onSave(chain).then(
          () => onSaved(chain),
          (err) => {
            setSaving(false);
            onError(err);
          },
        );
        return;
      }
      setChain(cur => cur.includes(item) ? cur.filter((m) => m !== item) : [...cur, item]);
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const selected = i === safeIdx;
        const cursor = (
          <Text color={selected ? theme.overlay.selectedColor : undefined}>
            {selected ? `${theme.overlay.selectedChar} ` : "  "}
          </Text>
        );
        if (item === SAVE_ROW) {
          return (
            <Box key={SAVE_ROW} marginTop={1}>
              {cursor}
              <Text bold={selected} dimColor={chain.length === 0}>
                完成并写入 fallback chain {chain.length > 0 ? `(${chain.length})` : ""}
              </Text>
            </Box>
          );
        }
        const priority = chain.indexOf(item) + 1;
        return (
          <Box key={item}>
            {cursor}
            {priority > 0 ? (
              <Text color="black" backgroundColor="green" bold> {priority} </Text>
            ) : (
              <Text dimColor>○</Text>
            )}
            <Text bold={selected}> {item}</Text>
            {!models.includes(item) ? <Text dimColor> (不在 models.json)</Text> : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>{saving ? "写入中..." : "↑↓ 移动  Enter 勾选/取消/完成  Esc 关闭"}</Text>
      </Box>
    </Box>
  );
}

export function useSlashCommands({
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
  setCompletedTurns,
  scrollToBottom,
}: UseSlashCommandsDeps): (command: string) => void {

  const pushSystemMessage = useCallback((text: string) => {
    appendSystemTurn(setCompletedTurns, text, scrollToBottom);
  }, [setCompletedTurns, scrollToBottom]);

  const handleModelPicker = useCallback(() => {
    const agentId = activeAgentRef.current;
    if (!agentId) {
      pushSystemMessage("没有选中 agent，请先 /agents 选择一个。");
      return;
    }
    if (!dataSource.listAvailableModels || !dataSource.readAgentOverrides || !dataSource.writeAgentOverrides) {
      pushSystemMessage("当前 dataSource 不支持 /model（需要 Gateway 通道）。");
      return;
    }

    const normalizeModelChain = (m: unknown): string[] => {
      if (Array.isArray(m)) {
        return m.filter((x) => x && String(x) !== "null").map(String);
      }
      if (typeof m === "string" && m && m !== "null") return [m];
      return [];
    };

    const formatModelChain = (models: string[]): string => models.join(" -> ");

    const showChainPicker = (models: string[], chain: string[]) => {
      scheduler.push({
        id: "model-picker",
        kind: "panel",
        layout: "fullscreen",
        title: `编排模型 fallback chain (${agentId})`,
        render: (close) => (
          <ModelChainPanel
            models={models}
            initialChain={chain}
            onSave={(nextChain) => {
              const value: string | string[] = nextChain.length === 1 ? nextChain[0]! : nextChain;
              return dataSource.writeAgentOverrides!(agentId, { models: { model: value } });
            }}
            onSaved={(nextChain) => {
              close();
              pushSystemMessage(`✅ 已切换 ${agentId} 的模型链路为 ${formatModelChain(nextChain)}\n   写入 team/homes/${agentId}/agent-overrides.json，agent 会自动热加载。`);
            }}
            onError={(err) => {
              pushSystemMessage(`❌ 写入 agent-overrides.json 失败: ${(err as Error)?.message ?? String(err)}`);
            }}
          />
        ),
      });
    };

    Promise.all([
      dataSource.listAvailableModels!(),
      dataSource.readAgentOverrides!(agentId),
      dataSource.fetchAgentJson?.(agentId) ?? Promise.resolve(null),
    ]).then(([models, overrides, agentJson]) => {
      if (models.length === 0) {
        pushSystemMessage("当前 models.json 为空，请先在 Gateway 注册模型。");
        return;
      }

      // 编辑缓冲：override 优先，否则把 agent.json 的 model 复制过来作为起点。
      const overrideModel = (overrides.models as Record<string, unknown> | undefined)?.model;
      const agentModel = (agentJson?.models as Record<string, unknown> | undefined)?.model;
      const overrideChain = normalizeModelChain(overrideModel);
      const agentChain = normalizeModelChain(agentModel);
      const initialChain = overrideChain.length > 0 ? overrideChain : agentChain;
      showChainPicker(models, initialChain);
    }).catch((err) => {
      pushSystemMessage(`❌ 读取模型配置失败: ${err?.message ?? String(err)}`);
    });
  }, [scheduler, dataSource, activeAgentRef, pushSystemMessage]);

  const handleTerminalSetup = useCallback(() => {
    const termProgram = process.env.TERM_PROGRAM;
    const isVscode = termProgram === "vscode";

    if (!isVscode) {
      const isNative = isNativeExtendedKeyTerminal();
      const lines = isNative
        ? [
            `当前终端 (${termProgram}) 原生支持扩展键序列，无需配置。`,
            "",
            "快捷键：",
            "  Shift+Enter → 换行    Ctrl+Enter → Steer    Ctrl+\\ → Steer (备用)",
          ]
        : [
            `当前终端: ${termProgram ?? "unknown"}`,
            "",
            "快捷键：",
            "  \\+Enter → 换行    Ctrl+\\ → Steer",
            "",
            "Shift+Enter 需要终端支持 Kitty 键盘协议。",
            "支持的终端: Ghostty, Kitty, iTerm2, WezTerm, Warp",
          ];
      pushSystemMessage(lines.join("\n"));
      return;
    }

    if (isRemoteSsh()) {
      scheduler.push({
        id: "terminal-setup",
        kind: "select",
        layout: "modal",
        title: "终端快捷键 (Remote SSH)",
        items: [
          { label: "查看本机安装说明" },
          { label: "不再提示本次启动弹窗", hint: "仅控制启动自动弹出" },
        ],
        onConfirm: (idx) => {
          if (idx === 0) pushSystemMessage(buildManualInstallInstructions());
          else if (idx === 1) setDismissed(true);
        },
      });
      return;
    }

    const status = checkSetupStatus();

    const items = status.allInstalled
      ? [
          { label: "卸载快捷键", hint: "移除 shift+enter / ctrl+enter 绑定" },
          { label: "查看状态" },
        ]
      : [
          { label: "安装快捷键", hint: "推荐 — 启用 Shift+Enter 换行 / Ctrl+Enter Steer" },
          { label: "查看状态" },
          ...(status.shiftEnterInstalled || status.ctrlEnterInstalled
            ? [{ label: "卸载快捷键", hint: "移除已安装的绑定" }]
            : []),
        ];

    scheduler.push({
      id: "terminal-setup",
      kind: "select",
      layout: "modal",
      title: "终端快捷键配置",
      items,
      onConfirm: (idx) => {
        const chosen = items[idx]!.label;

        if (chosen === "安装快捷键") {
          const result = installKeybindings();
          if (result.error) {
            pushSystemMessage(`❌ ${result.error}`);
          } else {
            const lines = ["终端快捷键配置"];
            if (result.installed.length > 0) {
              lines.push(`✅ 已安装: ${result.installed.join(", ")}`);
              lines.push(`   写入: ${getKeybindingsPath()}`);
            }
            if (result.skipped.length > 0) {
              lines.push(`⏭  已存在: ${result.skipped.join(", ")}`);
            }
            lines.push("", "快捷键：");
            lines.push("  Shift+Enter → 换行    Ctrl+Enter → Steer    Ctrl+\\ → Steer (备用)");
            pushSystemMessage(lines.join("\n"));
            setDismissed(false);
          }
        } else if (chosen === "卸载快捷键") {
          const result = uninstallKeybindings();
          if (result.error) {
            pushSystemMessage(`❌ ${result.error}`);
          } else {
            const lines = ["终端快捷键配置"];
            if (result.installed.length > 0) {
              lines.push(`🗑  已卸载: ${result.installed.join(", ")}`);
              lines.push(`   更新: ${getKeybindingsPath()}`);
            }
            if (result.skipped.length > 0) {
              lines.push(`⏭  未找到: ${result.skipped.join(", ")}`);
            }
            lines.push("", "备用方式仍可用：\\+Enter 换行，Ctrl+\\ Steer");
            pushSystemMessage(lines.join("\n"));
          }
        } else if (chosen === "查看状态") {
          const s = checkSetupStatus();
          const lines = [
            "终端快捷键状态",
            `  配置文件: ${s.kbPath ?? "未找到"}`,
            `  shift+enter: ${s.shiftEnterInstalled ? "✅ 已安装" : "❌ 未安装"}`,
            `  ctrl+enter:  ${s.ctrlEnterInstalled ? "✅ 已安装" : "❌ 未安装"}`,
          ];
          pushSystemMessage(lines.join("\n"));
        }
      },
    });
  }, [scheduler, pushSystemMessage]);

  // Render a worker command result as a system message. Panels that need
  // structured rendering should add their own panel component and call
  // callbacks.commandQuery/commandExecute directly.
  //
  // Success-with-dispatched (e.g. /compact, /skill-{name}) intentionally
  // produces no UI line — the dispatched tool will surface its own output
  // on the next turn. Errors always surface so failures aren't swallowed.
  const pushCommandResult = useCallback((name: string, result: CommandResult): void => {
    if (!result.ok) {
      pushSystemMessage(`[/${name}] ❌ ${result.error}`);
      return;
    }
    const data = result.data;
    if (data && typeof data === "object" && (data as Record<string, unknown>).dispatched === true) {
      return;
    }
    const repr = data == null ? "(no data)"
      : typeof data === "string" ? data
      : typeof data === "number" || typeof data === "boolean" ? String(data)
      : JSON.stringify(data, null, 2);
    pushSystemMessage(`[/${name}]\n${repr}`);
  }, [pushSystemMessage]);

  // Phase 1.1: fall back to the legacy agent_command (LLM tool_call) path.
  const fallbackToAgentCommand = useCallback((command: string): void => {
    const parsed = parseCommand(command);
    if (parsed) {
      const targetAgent = parsed.target === "/" ? activeAgentRef.current : parsed.target;
      callbacks.onAgentCommand(targetAgent, parsed.toolName, parsed.args);
    } else {
      callbacks.onUserInput(activeAgentRef.current, command, "turn");
    }
  }, [callbacks, activeAgentRef]);

  const handleSlashCommand = useCallback((command: string) => {
    const spec = resolveSlashCommand(command);

    switch (spec?.handler) {
      case "agents":
        showAgentPicker("fullscreen");
        return;
      case "model":
        handleModelPicker();
        return;
      case "instance":
        showInstancePicker();
        return;
      case "delete-agent":
        showDeleteCurrentAgent();
        return;
      case "delete-instance":
        showDeleteInstancePicker();
        return;
      case "clean-image":
        showPackCleanImage();
        return;
      case "rm-containers":
        showRemoveContainers();
        return;
      case "sync-pack":
        showSyncPack();
        return;
      case "load-pack":
        showLoadPack();
        return;
      case "restore":
        showTeamRestore();
        return;
      case "terminal-setup":
        handleTerminalSetup();
        return;
      case "board":
        scheduler.push({
          id: "board-panel",
          kind: "panel",
          layout: "fullscreen",
          title: `Board: ${activeAgentRef.current}`,
          render: (_close) => <BoardPanel agentId={activeAgentRef.current} />,
        });
        return;
      case "restart-instance": {
        // restartInstance lives on RendererDataSource (Gateway HTTP), NOT on
        // RendererCallbacks — reading from `callbacks` here was a wiring bug:
        // the property is permanently undefined on the callbacks object and the
        // guard short-circuited to the "dataSource 不支持" message.
        if (!dataSource.restartInstance) {
          pushSystemMessage("当前 dataSource 不支持 /restart_instance（需要 Gateway 通道）。");
          return;
        }
        if (!instanceId) {
          pushSystemMessage("还未选中 Instance，请先 /instance 选择一个。");
          return;
        }
        pushSystemMessage("⟳ 重启 Instance 中...");
        void dataSource.restartInstance(instanceId).then(
          () => pushSystemMessage("✓ Instance 已重启。"),
          (err: Error) => pushSystemMessage(`❌ 重启失败: ${err?.message ?? String(err)}`),
        );
        return;
      }
      case "agent-command":
      case undefined: {
        // Phase 1.1: worker-command fallback. If the slash command isn't in
        // SLASH_COMMANDS (spec === null) AND the subscriber supports the
        // command system, try worker query/execute first. Only fall back to
        // agent_command if worker says "Unknown command".
        if (spec === null && callbacks.commandQuery && callbacks.commandExecute) {
          const trimmed = command.replace(/^\/+/, "").trim();
          const [cmdName, ...argTokens] = trimmed.split(/\s+/);
          if (cmdName) {
            const args: string[] = argTokens;  // positional; worker module owns parsing
            const activeId = activeAgentRef.current;
            void (async () => {
              const r = await callbacks.commandQuery!(cmdName, args, activeId);
              if (r.ok) { pushCommandResult(cmdName, r); return; }
              if (r.error.includes("has no query")) {
                const r2 = await callbacks.commandExecute!(cmdName, args, activeId);
                pushCommandResult(cmdName, r2);
                return;
              }
              if (!r.error.startsWith("Unknown command")) {
                pushCommandResult(cmdName, r);
                return;
              }
              // True unknown → legacy agent_command fallback
              fallbackToAgentCommand(command);
            })();
            return;
          }
        }
        fallbackToAgentCommand(command);
      }
    }
  }, [
    callbacks, dataSource, scheduler, activeAgentRef, instanceId,
    showAgentPicker, showInstancePicker, showDeleteCurrentAgent,
    showDeleteInstancePicker, showPackCleanImage, showRemoveContainers, showSyncPack,
    showLoadPack, showTeamRestore, handleTerminalSetup, handleModelPicker,
  ]);

  return handleSlashCommand;
}
