/** @desc Plugin types — PluginFactory and PluginSource interfaces */
import type { AgentContext, CapabilityBase } from "../../core/types.js";

export type PluginFactory = (ctx: AgentContext) => PluginSource;

export interface PluginSource extends CapabilityBase {
  name: string;
  start(): void;
  stop(): void;
}
