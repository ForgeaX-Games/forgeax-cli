/** ContextEngine —— assemble system prompt blocks from `SlotRegistry`.
 *
 *  Lives between BaseAgent (owns the SlotRegistry instance) and
 *  ConsciousAgent's `assemblePrompt` callback. Returns `{ system,
 *  messages }`:
 *    - `system`   : SystemBlock[]  flat, sorted by (cacheHint section, priority asc)
 *    - `messages` : LLMMessage[]   passthrough of sessionHistory
 *
 *  Why a class（vs free function）：keeps the registry reference captured so
 *  callers don't reach into BaseAgent for slots. Matches ref shape; same
 *  contract.
 *
 *  Ported from `agenteam-os-ref/src/capability/slot/context-engine.ts`. */

import type { AgentContext, ModelSpec, SlotRegistryAPI } from "../../core/types";
import type { LLMMessage, SystemBlock } from "../../llm/types";
import { assembleSystemBlocks } from "./prompt-pipeline";

export interface AssembledPrompt {
  system: SystemBlock[];
  messages: LLMMessage[];
}

export class ContextEngine {
  constructor(private readonly registry: SlotRegistryAPI) {}

  async assemblePrompt(
    ctx: AgentContext,
    sessionHistory: LLMMessage[],
    _spec?: ModelSpec,
    _tokenBudget?: number,
    vars: Record<string, string> = {},
  ): Promise<AssembledPrompt> {
    const allSlots = this.registry.list();
    // 返回扁平 SystemBlock[]，由 prompt-pipeline 按 (cacheHint section,
    // priority asc) 排好。每个 block 自带 cacheHint，下游 provider 按需切
    // partition（stable → system field、dynamic → embed messages tail）。
    const system = await assembleSystemBlocks(allSlots, ctx, vars);
    return { system, messages: sessionHistory };
  }
}
