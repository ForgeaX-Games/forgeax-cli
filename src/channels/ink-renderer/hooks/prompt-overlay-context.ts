/**
 * Portal for command-suggestion data that floats above the prompt,
 * escaping the bottom-slot `overflowY:hidden` clip.
 *
 * Split into data/setter context pairs so the writer (InputBox) never
 * re-renders on its own writes — the setter context is stable.
 */

import React, { createContext, useContext, useState, useLayoutEffect } from "react";
import type { SlashCommand } from "../types.js";

export interface PromptOverlayData {
  suggestions: SlashCommand[];
  selectedIdx: number;
}

type SetFn = (data: PromptOverlayData | null) => void;

const DataContext = createContext<PromptOverlayData | null>(null);
const SetContext = createContext<SetFn | null>(null);

export function PromptOverlayProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [data, setData] = useState<PromptOverlayData | null>(null);
  return React.createElement(
    SetContext.Provider,
    { value: setData },
    React.createElement(DataContext.Provider, { value: data }, children),
  );
}

/**
 * Writer hook — call from InputBox to push suggestion data into the portal.
 * Cleanup automatically sets null when the component unmounts or data changes.
 */
export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  const set = useContext(SetContext);
  useLayoutEffect(() => {
    if (!set) return;
    set(data);
    return () => set(null);
  }, [set, data]);
}

/** Reader hook — call from SuggestionsOverlay to consume the data. */
export function usePromptOverlay(): PromptOverlayData | null {
  return useContext(DataContext);
}
