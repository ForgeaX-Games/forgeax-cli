/**
 * resolveKernel — 中立选择器:agentId → 已注册的 `AgentKernel`。
 *
 * 注册编排层**自带、无外部依赖**的内核(claude-code / codex,均只 spawn 子进程 +
 * 仅 import `@forgeax/agent-runtime`),按 `FORGEAX_KERNEL_IMPL` 选择(**默认 forgeax-core**;
 * 产品壳注册了才生效,否则 fallback 回落 claude-code)。
 * 缺内核 → 抛错,由 chat 出口翻成 `error{kernel_unavailable}`(不静默降级 Noop)。
 *
 * DIP:**原生 in-process 内核(如 forgeax-core)由产品壳在 boot 时注册进同一 in-proc
 * registry**(registry 住在 `@forgeax/agent-runtime`,cli 与 server 共享同一单例),cli
 * 这里只 `getKernel` 查找、绝不 import 任何具体内核实现包。
 * 后续:按 agent 偏好(agent.json / soul-pack)选,而非全局 env。
 */
import { type AgentKernel, type KernelId, getKernel, registerKernel, listKernels } from '@forgeax/agent-runtime';
import { ClaudeCodeKernel } from './claude-code-kernel';
import { CodexKernel } from './codex-kernel';
import { CursorKernel } from './cursor-kernel';
import { CbcKernel } from './cbc-kernel';

function ensureRegistered(): void {
  if (!getKernel('claude-code')) registerKernel(new ClaudeCodeKernel());
  if (!getKernel('codex')) registerKernel(new CodexKernel());
  if (!getKernel('cursor-agent')) registerKernel(new CursorKernel());
  // codebuddy(cbc):the reference agent CLI 近同源分叉,spawn `codebuddy -p` 子进程,自管登录。
  if (!getKernel('codebuddy')) registerKernel(new CbcKernel());
  // 原生内核(forgeax-core 等)不在此构造 —— 由产品壳注入进共享 registry(见上 DIP 说明)。
}

/** 已注册可选内核列表(确保自带内核已注册后枚举)。供 `/api/cli/health` 的
 *  provider 选择器列出 claude-code / codex / cursor-agent / codebuddy(+ 产品壳注入的
 *  forgeax-core),与 chat 路径 `resolveKernel(providerOverride)` 能跑的集合一致。 */
export function listAvailableKernels(): AgentKernel[] {
  ensureRegistered();
  return listKernels();
}

/**
 * @param _agentId  保留:未来按 agent 偏好(agent.json / soul-pack)选内核。
 * @param explicitImpl  本轮请求显式指定的内核 id(= UI 的 providerOverride,如
 *   'claude-code' / 'codex' / 'forgeax-core')。**优先于全局 env** —— 这样 UI 选
 *   "the reference agent CLI" 就真的跑 claude-code 内核(否则会被全局 FORGEAX_KERNEL_IMPL 顶掉,
 *   导致"在 the reference agent CLI 发的消息被当成 forgeax"的来源错配)。缺省/未注册才回落 env。
 */
export function resolveKernel(_agentId: string, explicitImpl?: string | null): AgentKernel {
  ensureRegistered();
  const requested = explicitImpl?.trim();
  // 显式请求优先且必须命中已注册内核;命中即用(不被 env 顶掉)。
  if (requested) {
    const rk = getKernel(requested as KernelId);
    if (rk) return rk;
    // 显式请求了但未注册 → 不静默降级 env(那正是错配根因),loud 抛错。
    throw new Error(`kernel_unavailable: ${requested}`);
  }
  // 默认内核 = forgeax-core(自研内核,产品壳 boot 时经 forgeax-core-adapter 注册)。
  //   未注册(纯 cli / 无 server)→ 下行 fallback 回落 claude-code,行为安全不失能。
  const impl = (process.env.FORGEAX_KERNEL_IMPL?.trim() || 'forgeax-core') as KernelId;
  const k = getKernel(impl) ?? getKernel('claude-code');
  if (!k) throw new Error(`kernel_unavailable: ${impl}`);
  return k;
}
