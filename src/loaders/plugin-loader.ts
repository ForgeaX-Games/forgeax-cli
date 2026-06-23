import type {
  PluginSource,
  PluginFactory,
} from "../capability/plugin/types.js";
import type {
  AgentContext,
} from "../core/types.js";
import { BaseLoader } from "./base-loader.js";

type PluginModule = { default?: PluginFactory };

/**
 * Stateless plugin loader. Returns PluginSource[] from disk scan.
 * Plugin start/stop lifecycle is managed by PluginRegistry.replaceStatic().
 */
export class PluginLoader extends BaseLoader<PluginModule, PluginSource | null> {
  protected readonly kind = "plugins" as const;

  createInstance(
    factory: PluginModule,
    ctx: AgentContext,
    name: string,
  ): PluginSource | null {
    if (typeof factory.default !== "function") return null;
    const source = factory.default(ctx);
    return { ...source, name };
  }

  async load(ctx: AgentContext): Promise<Map<string, PluginSource>> {
    const registry = await this.loadOnce(ctx);
    const result = new Map<string, PluginSource>();
    for (const [key, source] of registry) {
      if (source !== null) result.set(key, source);
    }
    return result;
  }
}
