/** PluginRegistry —— stores `PluginSource`; drives start/stop lifecycle on
 *  static replace + dynamic register/release.
 *
 *  Lifecycle policy（与 agenteam ref 对齐）：
 *  - `setContext(ctx)` 必须先调；没 ctx 时 replaceStatic 只更新 map，不 start。
 *  - `replaceStatic(map)` 用 ref-equality diff（content-hash ESM 保证未变文件
 *    返回同一 module ref → 同 `instance`）：
 *       removed / changed → 先 `stop()`（如果之前真 start 过）
 *       added / changed   → `start()`（被 `source.condition(ctx)` 否决则跳过）
 *  - `register(key, source)` —— 动态注册。已有同 key 先 stop 再覆盖；
 *    新 start 抛错回滚到旧实例。
 *  - `release(key)` —— stop + 从 dynamic map 删。
 *  - `clear()` —— 所有 dynamic + started static 都 stop 一遍，最后清空 map。
 *
 *  `startedKeys` 记录哪些 static plugin 实际跑过 start（被 condition 否决
 *  的没起），保证 stop 时不重复调用未启动的 plugin（吞掉 stop 抛错也写日志）。
 *
 *  Ported from `agenteam-os-ref/src/registries/plugin-registry.ts`. */

import type { AgentContext, PluginRegistryAPI } from "../core/types";
import { BaseRegistry } from "./base-registry";
import type { PluginSource, ReplaceDiff } from "./types";

export class PluginRegistry extends BaseRegistry<PluginSource> implements PluginRegistryAPI {
  private ctx: AgentContext | null = null;
  /** Static keys that were actually start()-ed (condition passed). */
  private startedKeys = new Set<string>();

  setContext(ctx: AgentContext): void {
    this.ctx = ctx;
  }

  /** Replace static sources with diff-based start/stop. Returns diff so the
   *  caller can decide whether to log; lifecycle side-effects happen inline. */
  async replaceStatic(sources: Map<string, PluginSource>): Promise<ReplaceDiff> {
    const prev = new Map(this.staticItems);                  // snapshot before replace
    const diff = this.replaceStaticItems(sources);

    // Stop removed + changed (only those we actually started before).
    for (const name of diff.removed) {
      if (this.startedKeys.has(name)) {
        await this.safeStop(name, prev.get(name)!);
        this.startedKeys.delete(name);
      }
    }
    for (const name of diff.changed) {
      if (this.startedKeys.has(name)) {
        await this.safeStop(name, prev.get(name)!);
        this.startedKeys.delete(name);
      }
    }

    if (!this.ctx) return diff;

    for (const name of diff.added) {
      await this.startSource(name, sources.get(name)!);
    }
    for (const name of diff.changed) {
      await this.startSource(name, sources.get(name)!);
    }
    return diff;
  }

  private async startSource(name: string, source: PluginSource): Promise<void> {
    if (source.condition && this.ctx && !source.condition(this.ctx, source)) return;
    try {
      await Promise.resolve(source.start());
      this.startedKeys.add(name);
    } catch (err: any) {
      process.stderr.write(
        `[PluginRegistry] start "${name}" failed: ${err?.message ?? err}\n`,
      );
    }
  }

  private async safeStop(name: string, source: PluginSource): Promise<void> {
    try {
      await Promise.resolve(source.stop());
    } catch (err: any) {
      process.stderr.write(
        `[PluginRegistry] stop "${name}" failed: ${err?.message ?? err}\n`,
      );
    }
  }

  override patchStatic(key: string, source: PluginSource): PluginSource | undefined {
    const old = this.staticItems.get(key);
    const prev = super.patchStatic(key, source);
    if (old === source) return undefined;
    if (old && this.startedKeys.has(key)) {
      void this.safeStop(key, old);
      this.startedKeys.delete(key);
    }
    if (this.ctx) void this.startSource(key, source);
    return prev;
  }

  override removeStatic(key: string): PluginSource | undefined {
    const prev = super.removeStatic(key);
    if (prev && this.startedKeys.has(key)) {
      void this.safeStop(key, prev);
      this.startedKeys.delete(key);
    }
    return prev;
  }

  register(key: string, source: PluginSource): void {
    const previous = this.dynamicItems.get(key);
    if (previous) {
      void this.safeStop(key, previous);
    }
    this.dynamicItems.set(key, source);
    if (!this.ctx) return;

    try {
      void Promise.resolve(source.start()).catch((err) => {
        process.stderr.write(
          `[PluginRegistry] dynamic start "${key}" failed: ${err?.message ?? err}\n`,
        );
        this.dynamicItems.delete(key);
        if (!previous) return;
        try {
          this.dynamicItems.set(key, previous);
          void Promise.resolve(previous.start()).catch((re) =>
            process.stderr.write(
              `[PluginRegistry] restore previous "${key}" failed: ${re?.message ?? re}\n`,
            ),
          );
        } catch (re: any) {
          process.stderr.write(
            `[PluginRegistry] failed to restore previous dynamic "${key}": ${re?.message ?? re}\n`,
          );
          this.dynamicItems.delete(key);
        }
      });
    } catch (err: any) {
      process.stderr.write(
        `[PluginRegistry] dynamic start "${key}" threw sync: ${err?.message ?? err}\n`,
      );
      this.dynamicItems.delete(key);
    }
  }

  release(key: string): void {
    const source = this.dynamicItems.get(key);
    if (!source) return;
    try {
      void this.safeStop(key, source);
    } finally {
      this.dynamicItems.delete(key);
    }
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
    for (const [name, source] of this.dynamicItems) {
      void this.safeStop(name, source);
    }
    for (const [name, source] of this.staticItems) {
      if (this.startedKeys.has(name)) {
        void this.safeStop(name, source);
      }
    }
    this.startedKeys.clear();
    super.clear();
  }
}
