/**
 * OverlayLayer — reads scheduler state and renders the matching overlay component.
 * Dispatches to SelectOverlay for "select" kind, PanelOverlay for "panel" kind.
 */

import React, { useState } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { PanelOverlay } from "./PanelOverlay.js";
import { theme } from "../lib/theme.js";
import type { OverlaySchedulerResult } from "../hooks/use-overlay-scheduler.js";

interface OverlayLayerProps {
  scheduler: OverlaySchedulerResult;
}

export function OverlayLayer({ scheduler }: OverlayLayerProps): React.JSX.Element | null {
  const { current, isLoading, items, confirm, cancel } = scheduler;

  if (!current) return null;

  let content: React.JSX.Element | null = null;

  if (current.kind === "panel" && current.render) {
    content = (
      <PanelOverlay key={current.id} title={current.title} onClose={cancel}>
        {current.render(cancel)}
      </PanelOverlay>
    );
  } else if (current.kind === "select") {
    content = (
      <SchedulerSelectOverlay
        key={current.id}
        title={current.title}
        items={items}
        isLoading={isLoading}
        onConfirm={confirm}
        onCancel={cancel}
      />
    );
  }

  if (!content) return null;

  return content;
}

interface SchedulerSelectOverlayProps {
  title: string;
  items: Array<{ label: string; hint?: string; hintColor?: string; disabled?: boolean }>;
  isLoading: boolean;
  onConfirm: (idx: number) => void;
  onCancel: () => void;
}

function findNextEnabled(items: SchedulerSelectOverlayProps["items"], from: number, dir: 1 | -1): number {
  let i = from;
  while (i >= 0 && i < items.length) {
    if (!items[i]!.disabled) return i;
    i += dir;
  }
  return -1;
}

function SchedulerSelectOverlay({
  title,
  items,
  isLoading,
  onConfirm,
  onCancel,
}: SchedulerSelectOverlayProps): React.JSX.Element {
  const firstEnabled = items.findIndex(it => !it.disabled);
  const [idx, setIdx] = useState(Math.max(0, firstEnabled));
  const [confirming, setConfirming] = useState(false);

  useInput((_input, key) => {
    if (isLoading || confirming) return;
    if (key.upArrow) {
      setIdx(cur => {
        const next = findNextEnabled(items, cur - 1, -1);
        return next >= 0 ? next : cur;
      });
    }
    if (key.downArrow) {
      setIdx(cur => {
        const next = findNextEnabled(items, cur + 1, 1);
        return next >= 0 ? next : cur;
      });
    }
    if (key.return && items.length > 0 && !items[idx]?.disabled) {
      setConfirming(true);
      onConfirm(idx);
    }
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle={theme.overlay.borderStyle} borderColor={theme.overlay.borderColor}>
      <Text bold> {title} </Text>
      {isLoading ? (
        <Text color={theme.overlay.loadingColor}> 加载中...</Text>
      ) : items.length === 0 ? (
        <Text dimColor> 无可用选项</Text>
      ) : (
        items.map((item, i) => {
          const selected = i === idx;
          const disabled = !!item.disabled;
          return (
            <Box key={i}>
              <Text color={disabled ? theme.overlay.disabledColor : selected ? theme.overlay.selectedColor : undefined}>
                {selected ? `${theme.overlay.selectedChar} ` : "  "}
              </Text>
              <Text bold={selected && !disabled} dimColor={disabled} strikethrough={disabled}>
                {item.label}
              </Text>
              {item.hint ? (
                <Text color={disabled ? theme.overlay.disabledColor : (item.hintColor as any) ?? undefined} dimColor={disabled && !item.hintColor}>
                  {" "}{item.hint}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
      {confirming ? (
        <Text color={theme.overlay.loadingColor}> 处理中...</Text>
      ) : (
        <Text dimColor> ↑↓ 移动  Enter 确认  Esc 取消</Text>
      )}
    </Box>
  );
}
