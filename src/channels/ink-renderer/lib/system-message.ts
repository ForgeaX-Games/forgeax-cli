// @desc System-message helpers for renderer-local status turns
import type React from "react";
import type { CompletedTurn, RendererMessage } from "../types.js";

export function makeSystemTurn(text: string, timestamp = Date.now()): CompletedTurn {
  const msg: RendererMessage = {
    kind: "system",
    text,
    source: "system",
    agent: "",
    timestamp,
  };
  return { agent: "system", messages: [msg], timestamp };
}

export function appendSystemTurn(
  setCompletedTurns: React.Dispatch<React.SetStateAction<CompletedTurn[]>>,
  text: string,
  scrollToBottom?: () => void,
): void {
  setCompletedTurns(prev => [...prev, makeSystemTurn(text)]);
  scrollToBottom?.();
}
