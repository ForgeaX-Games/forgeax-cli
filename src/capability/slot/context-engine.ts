/** @desc ContextEngine — assembles system prompt from slot registry */
import type { AgentContext, ModelSpec } from "../../core/types.js";
import type { LLMMessage, SystemBlock } from "../../llm/types.js";
import type { SlotRegistryView } from "../../registries/types.js";
import { assembleSystemBlocks } from "./prompt-pipeline.js";

export interface AssembledPrompt {
  system: SystemBlock[];
  messages: LLMMessage[];
}

export class ContextEngine {
  private registry: SlotRegistryView;

  constructor(registry: SlotRegistryView) {
    this.registry = registry;
  }

  async assemblePrompt(
    ctx: AgentContext,
    sessionHistory: LLMMessage[],
    _spec?: ModelSpec,
    _tokenBudget?: number,
    vars: Record<string, string> = {},
  ): Promise<AssembledPrompt> {
    const allSlots = this.registry.all();
    // Returns flat SystemBlock[] sorted by (cacheHint section, priority asc).
    // Each block carries its own cacheHint — downstream providers partition on
    // it to decide wire format (e.g. stable → system field, dynamic → embedded
    // in messages tail). Framework no longer concats or routes; provider knows
    // its own API best.
    const system = await assembleSystemBlocks(allSlots, ctx, vars);
    return { system, messages: sessionHistory };
  }
}
