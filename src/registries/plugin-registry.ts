import type { AgentContext, DynamicPluginAPI } from "../core/types.js";
import type { PluginSource } from "../capability/plugin/types.js";
import { BaseRegistry } from "./base-registry.js";
import { runWithAgentScope, withModelFeedback } from "../core/logger.js";

export class PluginRegistry extends BaseRegistry<PluginSource> implements DynamicPluginAPI {
  private ctx: AgentContext | null = null;
  private logAgentId = "system";
  /** Tracks which static plugins were actually start()-ed (condition passed). */
  private startedKeys = new Set<string>();

  setContext(ctx: AgentContext): void {
    this.ctx = ctx;
  }

  setLogContext(agentId: string): void {
    this.logAgentId = agentId;
  }

  /**
   * Replace static sources with diff-based start/stop lifecycle.
   *
   * Content-hash cache keys (`?v=sha1`) ensure unchanged modules return
   * the same ESM reference. Only truly changed or removed plugins are
   * stopped; only new or changed plugins are started.
   */
  replaceStatic(sources: Map<string, PluginSource>): void {
    const prev = this.staticItems;
    const diff = this.replaceStaticItems(sources);

    for (const name of diff.removed) {
      if (this.startedKeys.has(name)) {
        try { prev.get(name)!.stop(); } catch { /* already stopped */ }
        this.startedKeys.delete(name);
      }
    }
    for (const name of diff.changed) {
      if (this.startedKeys.has(name)) {
        try { prev.get(name)!.stop(); } catch { /* already stopped */ }
        this.startedKeys.delete(name);
      }
    }

    if (!this.ctx) return;
    for (const name of diff.added) {
      this.startSource(name, sources.get(name)!);
    }
    for (const name of diff.changed) {
      this.startSource(name, sources.get(name)!);
    }
  }

  private startSource(name: string, source: PluginSource): void {
    if (source.condition && this.ctx && !source.condition(this.ctx, source)) return;
    try {
      runWithAgentScope(this.logAgentId, () => {
        source.start();
      });
      this.startedKeys.add(name);
    } catch (err) {
      withModelFeedback(() => console.error(`[PluginRegistry] subscription_error for "${name}"`, err));
    }
  }

  override patchStatic(key: string, source: PluginSource): PluginSource | undefined {
    const old = this.staticItems.get(key);
    const prev = super.patchStatic(key, source);
    if (old === source) return undefined;
    if (old && this.startedKeys.has(key)) {
      try { old.stop(); } catch { /* already stopped */ }
      this.startedKeys.delete(key);
    }
    if (this.ctx) this.startSource(key, source);
    return prev;
  }

  override removeStatic(key: string): PluginSource | undefined {
    const prev = super.removeStatic(key);
    if (prev && this.startedKeys.has(key)) {
      try { prev.stop(); } catch { /* already stopped */ }
      this.startedKeys.delete(key);
    }
    return prev;
  }

  register(key: string, source: PluginSource): void {
    const previous = this.dynamicItems.get(key);
    if (previous) {
      try { previous.stop?.(); } catch { /* ignore */ }
    }

    this.dynamicItems.set(key, source);
    if (!this.ctx) return;

    try {
      source.start();
    } catch (err) {
      console.error(`[PluginRegistry] failed to start dynamic source "${key}"`, err);
      this.dynamicItems.delete(key);
      try { source.stop?.(); } catch { /* ignore */ }

      if (!previous) return;
      try {
        this.dynamicItems.set(key, previous);
        previous.start();
      } catch (restoreErr) {
        console.error(`[PluginRegistry] failed to restore previous dynamic source "${key}"`, restoreErr);
        this.dynamicItems.delete(key);
      }
    }
  }

  release(key: string): void {
    const source = this.dynamicItems.get(key);
    if (!source) return;
    try { source.stop?.(); } finally { this.dynamicItems.delete(key); }
  }

  get(key: string): PluginSource | undefined {
    const resolved = this.resolveKey(key);
    if (resolved === undefined) return undefined;
    return this.dynamicItems.get(resolved) ?? this.staticItems.get(resolved);
  }

  list(): PluginSource[] {
    return this.all();
  }

  override clear(): void {
    for (const source of this.dynamicItems.values()) source.stop?.();
    for (const [name, source] of this.staticItems) {
      if (this.startedKeys.has(name)) {
        try { source.stop?.(); } catch { /* ignore */ }
      }
    }
    this.startedKeys.clear();
    super.clear();
  }
}
