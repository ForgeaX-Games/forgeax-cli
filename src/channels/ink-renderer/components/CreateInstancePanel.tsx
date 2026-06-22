/**
 * CreateInstancePanel — text input panel for creating a new instance.
 * Rendered inside a panel overlay from the /instance picker.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { theme } from "../lib/theme.js";
import { useSimpleInput } from "../hooks/use-simple-input.js";
import type { RendererDataSource } from "../types.js";

interface CreateInstancePanelProps {
  dataSource: RendererDataSource;
  close: () => void;
  onCreated?: (id: string) => void;
}

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function CreateInstancePanel({ dataSource, close, onCreated }: CreateInstancePanelProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (submitting) {
      const start = Date.now();
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [submitting]);

  const submit = useCallback(async (raw: string) => {
    const id = raw.trim();
    if (!id) { setError("ID 不能为空"); return; }
    if (!ID_PATTERN.test(id)) { setError("仅允许字母、数字、下划线和连字符"); return; }
    if (id.length > 64) { setError("ID 过长（最多 64 字符）"); return; }
    if (!dataSource.addInstance) { setError("当前环境不支持创建 Instance"); return; }

    setSubmitting(true);
    setError(null);
    try {
      await dataSource.addInstance(id);
      onCreated?.(id);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
      setElapsed(0);
    }
  }, [dataSource, close, onCreated]);

  const { before, at, after } = useSimpleInput({
    onSubmit: submit,
    onChange: () => setError(null),
    isActive: !submitting,
  });

  const spinChar = SPINNER[elapsed % SPINNER.length];

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text> 输入实例 ID:</Text>
      <Box paddingLeft={1}>
        <Text color={theme.overlay.selectedColor}>{">"} </Text>
        <Text>{before}</Text>
        {!submitting ? <Text color={theme.overlay.selectedColor} inverse>{at || " "}</Text> : null}
        <Text>{after}</Text>
      </Box>
      {error ? (
        <Box paddingLeft={1} paddingTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}
      {submitting ? (
        <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
          <Text color={theme.overlay.loadingColor}>{spinChar} 创建中... ({elapsed}s)</Text>
          <Text dimColor>  首次启动需要克隆模板和安装依赖，可能需要 1-2 分钟</Text>
        </Box>
      ) : null}
    </Box>
  );
}
