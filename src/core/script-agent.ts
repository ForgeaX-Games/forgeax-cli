/** ScriptAgent —— 跑用户写的 TS / JS 脚本作为 agent 主循环。
 *
 *  本轮（C6）只落 interface，不落实际 runMain 实现。Scheduler / SessionManager 还没好，
 *  动态 import + ESM cache busting 那套等 C8/C11 一起接进来。
 *
 *  ref：agenteam-os src/core/script-agent.ts 56 行。
 *  脚本 entry 路径约定：`<agentDir>/src/index.ts`（与 ref 一致）。 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BaseAgent } from "./base-agent";
import type { AgentContext, Event } from "../core/types";

/** Script entry segment —— 相对 agentDir 的入口。 */
export const SCRIPT_ENTRY_SEGMENTS = ["src", "index.ts"] as const;

/** 用户脚本的最小契约：可选 start，必有 update。 */
export interface ScriptModule {
  start?: (ctx: AgentContext) => void | Promise<void>;
  update: (events: Event[], ctx: AgentContext) => void | Promise<void>;
}

export class ScriptAgent extends BaseAgent {
  /** Resolve module URL with ESM cache-bust query param. */
  protected scriptModuleUrl(): string {
    return `${pathToFileURL(join(this.agentDir, ...SCRIPT_ENTRY_SEGMENTS)).href}?v=${Date.now()}`;
  }

  async run(signal: AbortSignal): Promise<void> {
    return this.runMain(signal);
  }

  async runMain(_signal: AbortSignal): Promise<void> {
    // 占位：完整 turn loop（waitForEvent → coalesce → drain → mod.update）
    // 等 C8/C11 把 Scheduler / Session 接进来后再补。
    throw new Error("ScriptAgent.runMain not implemented yet (C6 interface-only stub)");
  }
}
