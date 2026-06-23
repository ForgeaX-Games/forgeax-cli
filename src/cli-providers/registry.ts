/** CliProvider registry（精简版 · 2026-05-20）。
 *
 *  旧版（commit 64078a4 之前）支持 4 个 provider（forgeax / claude-code / codex /
 *  cursor-agent）+ marketplace 路由 + prefix mapping。R3 阶段先只挂 claude-code
 *  一个，作为 interface 还能 chat 的临时桥。codex / cursor-agent / forgeax-cli
 *  日后随需补回（每个 ~250 LOC 重新接 provider 实现 + 加一行 registerProvider）。
 *
 *  与新 commands 系统的关系：
 *  - 本 registry **不挂 commands transport**，纯独立 REST 分支（POST /api/cli/chat
 *    SSE）；命令系统通过 `cli_providers_list` 等 temporary 命令读取本 registry 元数据
 *    （R3 后期补，本轮不在范围）。
 *  - lifecycle 标记：整个 /api/cli/ 分支带 `Deprecation: true` header；目标是
 *    forgeax-v1.0 sunset，届时被原生 ScriptAgent / commands `attach_script_agent`
 *    取代。 */

import type { CliProvider, ProviderId } from "./types";

const providers = new Map<ProviderId, CliProvider>();
let defaultProviderId: ProviderId | null = null;

export function registerProvider(p: CliProvider, opts?: { default?: boolean }): void {
  providers.set(p.id, p);
  if (opts?.default || defaultProviderId === null) defaultProviderId = p.id;
}

export function unregisterProvider(id: ProviderId): void {
  providers.delete(id);
  if (defaultProviderId === id) defaultProviderId = null;
}

export function getProvider(id: ProviderId): CliProvider | undefined {
  return providers.get(id);
}

export function listProviders(): CliProvider[] {
  return [...providers.values()];
}

export function getDefaultProvider(): CliProvider | null {
  if (!defaultProviderId) return null;
  return providers.get(defaultProviderId) ?? null;
}

/** R3 阶段简化版：缺省路由 = default provider；不再做 PREFIX_MAP / marketplace
 *  lookup（那套要等 marketplace 系统重新接进来才有意义）。 */
export function resolveProvider(_agentId?: string, hint?: { declaredProvider?: ProviderId }): CliProvider | null {
  if (hint?.declaredProvider) {
    const p = providers.get(hint.declaredProvider);
    if (p) return p;
  }
  return getDefaultProvider();
}

/** Test-only */
export function _resetRegistry(): void {
  providers.clear();
  defaultProviderId = null;
}
