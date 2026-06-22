/** @desc ContextBar — renders a simple block progress bar for context usage in the status bar */

import { C } from "../../shared/ansi.js";
import { getModelSpec } from "../../../llm/provider.js";

const BAR_WIDTH = 8; // number of block segments

function buildBar(pct: number, color: string): { text: string; fmt: string } {
  const filled = Math.round(pct * BAR_WIDTH);
  const empty  = BAR_WIDTH - filled;
  const label  = `${Math.round(pct * 100)}%`.padStart(4);

  const barText = `▕${"█".repeat(filled)}${"░".repeat(empty)}▏ ${label}`;
  const barFmt  = `${C.dim}▕${C.reset}${color}${"█".repeat(filled)}${C.reset}${C.dim}${"░".repeat(empty)}▏${C.reset}${C.dim} ${label}${C.reset}`;

  return { text: barText, fmt: barFmt };
}

export interface ContextRingView {
  /** Plain-text string (used to measure display width for alignment) */
  text: string;
  /** ANSI-formatted string (written to stdout) */
  fmt: string;
}

export class ContextRing {
  ratio: number | null = null;
  private unwatch: (() => void) | null = null;

  /** Called by the renderer whenever the status bar needs to be redrawn. */
  render(): ContextRingView {
    if (this.ratio === null) {
      // Placeholder: empty bar, shown before the first LLM call populates TeamBoard
      const barText = `▕${"░".repeat(BAR_WIDTH)}▏   —%`;
      const barFmt  = `${C.dim}▕${"░".repeat(BAR_WIDTH)}▏   —%${C.reset}`;
      return { text: barText, fmt: barFmt };
    }

    const pct   = Math.min(1, Math.max(0, this.ratio));
    const color = pct >= 0.9 ? "\x1b[91m"   // bright red
                : pct >= 0.7 ? C.red
                : pct >= 0.5 ? C.yellow
                : C.green;

    return buildBar(pct, color);
  }

  /**
   * Subscribe to context usage updates for `agentId`.
   * `watchFn` should return an unsubscribe callback (same contract as `RendererCallbacks.watchContextUsage`).
   * Any previous plugin is cleaned up first.
   */
  subscribe(
    agentId: string,
    watchFn: (agentId: string, cb: (ratio: number | null) => void) => () => void,
    onUpdate: () => void,
  ): void {
    this.unsubscribe();
    this.ratio = null;
    if (!agentId) return;

    this.unwatch = watchFn(agentId, (ratio) => {
      this.ratio = ratio;
      onUpdate();
    });
  }

  unsubscribe(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.ratio   = null;
  }

  /** Compute context usage ratio from assistantMessage payload-level usage + model. */
  static ratioFromAssistantMessage(payload: Record<string, unknown>): number | null {
    const usage = payload.usage as { inputTokens: number; outputTokens: number } | undefined;
    const model = payload.model as string | undefined;
    if (!usage || !model) return null;
    const total = usage.inputTokens + usage.outputTokens;
    try {
      const cw = getModelSpec(model).contextWindow;
      return cw && cw > 0 ? total / cw : null;
    } catch { return null; }
  }
}
