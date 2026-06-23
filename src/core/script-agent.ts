/** @desc ScriptAgent — runs user-defined TypeScript scripts */

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { AgentContext, Event, AgentInitConfig } from "./types.js";
import { BaseAgent } from "./base-agent.js";

/** Relative path segments from agent root to the ScriptAgent entry file. */
export const SCRIPT_ENTRY_SEGMENTS = ["src", "index.ts"] as const;

interface ScriptModule {
  start?: (ctx: AgentContext) => void | Promise<void>;
  update: (events: Event[], ctx: AgentContext) => void | Promise<void>;
}

export class ScriptAgent extends BaseAgent {
  constructor(config: AgentInitConfig) {
    super(config);
    this.watchAgentJson();
  }

  protected async runMain(_signal: AbortSignal): Promise<void> {
    const modulePath = pathToFileURL(join(this.agentDir, ...SCRIPT_ENTRY_SEGMENTS)).href;
    // Cache-bust: append unique query param so ESM loader re-evaluates the module
    const mod = (await import(`${modulePath}?v=${Date.now()}`)) as ScriptModule;

    if (mod.start) await mod.start(this.agentContext);

    while (!this.shuttingDown) {
      if (this.abortController.signal.aborted) {
        this.abortController = new AbortController();
      }

      try {
        await this.queue.waitForEvent(this.signal);
      } catch {
        continue;
      }

      if (this.coalesceMs > 0) {
        await new Promise((r) => setTimeout(r, this.coalesceMs));
      }

      const events = this.queue.drain();
      if (events.length > 0) {
        await mod.update(events, this.agentContext);
      }
    }
  }
}
