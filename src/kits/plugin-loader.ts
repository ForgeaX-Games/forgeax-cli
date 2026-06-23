/** KitPluginLoader —— stateless plugin kit loader.
 *
 *  Plugins are factory-driven: `factory(ctx)` returns `{ start, stop, ... }`.
 *  Start/stop lifecycle is owned by `PluginRegistry.replaceStatic` —— this
 *  loader just produces the `PluginSource` objects.
 *
 *  Ported from `agenteam-os-ref/src/loaders/plugin-loader.ts`. */

import type { AgentContext } from "../core/types";
import type { PluginFactory, PluginSource } from "./types";
import { BaseKitLoader } from "./base-loader";

type PluginModule = { default?: PluginFactory };

export class KitPluginLoader extends BaseKitLoader<PluginModule, PluginSource | null> {
  protected readonly kind = "plugins" as const;

  createInstance(
    factory: PluginModule,
    ctx: AgentContext,
    name: string,
  ): PluginSource | null {
    if (typeof factory.default !== "function") return null;
    try {
      const source = factory.default(ctx);
      if (!source || typeof source !== "object") return null;
      if (typeof source.start !== "function" || typeof source.stop !== "function") {
        process.stderr.write(`[KitPluginLoader] skipped "${name}": missing start/stop\n`);
        return null;
      }
      return { ...source, name };
    } catch (err: any) {
      process.stderr.write(`[KitPluginLoader] factory error for "${name}": ${err?.message ?? err}\n`);
      return null;
    }
  }

  async load(ctx: AgentContext): Promise<Map<string, PluginSource>> {
    const reg = await this.loadOnce(ctx);
    const out = new Map<string, PluginSource>();
    for (const [k, v] of reg) {
      if (v !== null) out.set(k, v);
    }
    return out;
  }
}
