/** ToolRegistry — dynamic-then-static lookup with bare-name resolution.
 *  Ported from agenteam-os-ref/src/registries/tool-registry.ts. */

import type { ToolDefinition, ToolRegistryAPI } from "../core/types";
import { BaseRegistry } from "./base-registry";

export class ToolRegistry extends BaseRegistry<ToolDefinition> implements ToolRegistryAPI {

  replaceStatic(tools: Map<string, ToolDefinition>): void {
    this.replaceStaticItems(tools);
  }

  register(key: string, tool: ToolDefinition): void {
    this.dynamicItems.set(key, tool);
  }

  release(key: string): void {
    this.dynamicItems.delete(key);
  }

  get(key: string): ToolDefinition | undefined {
    const resolved = this.resolveKey(key);
    if (resolved === undefined) return undefined;
    return this.dynamicItems.get(resolved) ?? this.staticItems.get(resolved);
  }

  list(): ToolDefinition[] {
    return this.all();
  }
}
