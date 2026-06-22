/**
 * useCommandRouter — slash command matching, suggestion list, and navigation.
 *
 * When input starts with `/`, filters BUILTIN_COMMANDS by prefix match.
 * Provides Tab completion, arrow-key navigation, and Enter execution.
 */

import { useState, useCallback, useMemo } from "react";
import type { SlashCommand } from "../types.js";
import type { CommandSpec } from "../../../capability/command/types.js";
import { getSlashCommandSuggestions } from "../lib/slash-command-registry.js";

export interface CommandRouterState {
  suggestions: SlashCommand[];
  selectedIdx: number;
  isActive: boolean;
}

export interface CommandRouterActions {
  moveUp: () => void;
  moveDown: () => void;
  /** Apply tab-completion: returns the completed command name or null. */
  tabComplete: (currentInput: string) => string | null;
  /** Execute the selected suggestion; returns the command name or null. */
  confirmSelected: () => string | null;
}

export function useCommandRouter(
  input: string,
  remoteCommands: readonly CommandSpec[] = [],
): CommandRouterState & CommandRouterActions {
  const [selectedIdx, setSelectedIdx] = useState(0);

  const suggestions = useMemo(() => {
    if (!input.startsWith("/")) return [];
    const prefix = input.slice(1).toLowerCase();
    return getSlashCommandSuggestions(prefix, remoteCommands);
  }, [input, remoteCommands]);

  const isActive = suggestions.length > 0 && input.startsWith("/");

  const clampedIdx = isActive ? Math.min(selectedIdx, suggestions.length - 1) : 0;

  const moveUp = useCallback(() => {
    setSelectedIdx(i => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIdx(i => Math.min(suggestions.length - 1, i + 1));
  }, [suggestions.length]);

  const tabComplete = useCallback((_currentInput: string): string | null => {
    if (!isActive || suggestions.length === 0) return null;
    const cmd = suggestions[clampedIdx];
    if (!cmd) return null;
    return `/${cmd.name}`;
  }, [isActive, suggestions, clampedIdx]);

  const confirmSelected = useCallback((): string | null => {
    if (!isActive || suggestions.length === 0) return null;
    const cmd = suggestions[clampedIdx];
    if (!cmd) return null;
    setSelectedIdx(0);
    return cmd.name;
  }, [isActive, suggestions, clampedIdx]);

  return {
    suggestions,
    selectedIdx: clampedIdx,
    isActive,
    moveUp,
    moveDown,
    tabComplete,
    confirmSelected,
  };
}
