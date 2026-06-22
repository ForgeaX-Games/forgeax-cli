/**
 * useSimpleInput — lightweight single-line text editor state with cursor.
 *
 * Shared by overlay panels (TextInputPanel, CreateInstancePanel, etc.)
 * that need basic cursor navigation without the full segment/history/kill-ring
 * machinery of useInputState.
 *
 * Features:
 *   - Cursor navigation: ← → arrows
 *   - Home / End: Ctrl+A / Ctrl+E
 *   - Backspace at cursor position
 *   - Character insertion at cursor position
 */

import { useState, useCallback } from "react";
import useInput from "../ink/hooks/use-input.js";

export interface SimpleInputState {
  value: string;
  cursor: number;
  before: string;
  at: string;
  after: string;
  setValue: (v: string) => void;
}

interface UseSimpleInputOptions {
  defaultValue?: string;
  onSubmit: (value: string) => void;
  onChange?: () => void;
  isActive?: boolean;
}

export function useSimpleInput({
  defaultValue = "",
  onSubmit,
  onChange,
  isActive,
}: UseSimpleInputOptions): SimpleInputState {
  const [value, setValueRaw] = useState(defaultValue);
  const [cursor, setCursor] = useState(defaultValue.length);

  const setValue = useCallback((v: string) => {
    setValueRaw(v);
    setCursor(v.length);
  }, []);

  useInput((input, key) => {
    if (key.return) { onSubmit(value); return; }

    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(c => Math.min(value.length, c + 1));
      return;
    }
    if (input === "a" && key.ctrl) { setCursor(0); return; }
    if (input === "e" && key.ctrl) { setCursor(value.length); return; }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValueRaw(v => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor(c => c - 1);
        onChange?.();
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValueRaw(v => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor(c => c + input.length);
      onChange?.();
    }
  }, { isActive });

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? "";
  const after = value.slice(cursor + 1);

  return { value, cursor, before, at, after, setValue };
}
