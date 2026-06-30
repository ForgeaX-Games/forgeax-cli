// @desc Command system — types (CommandModule / Spec / Result / Context)
//
// 直接镜像 agenteam-os-ref/src/capability/command/types.ts 的形状：
//
//   一个 CommandModule = 一个 `commands/*.ts` 文件，可注册 N 条命令；同一条命令
//   可同时实现 query + execute。Spec 用 hasQuery / hasExecute 而**不**是 kind，
//   让模块自由组合两侧（如 list_sessions 只 query，switch-session 只 execute，
//   set_session 两侧都有也合法）。
//
//   args 一律 positional `string[]`，模块自己解析（复杂数据约定走
//   `args[N] = JSON.stringify(value)` —— 同 agenteam ref `commands/models.ts`）。
//   Runner 保证 args 是 string[]，不做任何 schema 校验。
//
//   Runner 是 stateless 的：每次 list/query/execute 都重扫目录 + dynamic import
//   （mtime cache bust），没有进程内 registry。这意味着改一个 commands/*.ts 文件
//   不需要重启 server，下一次调用即生效。

import type { SessionManager } from "../core/session-manager";
import type { PathManagerAPI } from "../fs/types";

export interface CommandModule {
  /** 必填：列出本模块拥有的所有 CommandSpec。Spec 用来做 list 接口 + 路由分发依据。 */
  list(ctx: ModuleContext): Promise<CommandSpec[]>;
  /** 读侧 query。args 是位置参数 string[]，模块自己解析（缺省返回 `[]`，由 runner 保证）。 */
  query?(name: string, args: string[], ctx: CallContext): Promise<unknown>;
  /** 写侧 execute（有副作用）。args 同上。 */
  execute?(name: string, args: string[], ctx: CallContext): Promise<unknown>;
}

/** Module ctx —— 等价于 agenteam ref 的 `{ scheduler, instanceDir, requestingAgentId }`。
 *  forgeax 的对应物：`{ sm, paths, sessionId?, requestingAgentId? }`。
 *  - `sm` ≈ scheduler 那一层全局服务句柄（管 sessions）
 *  - `paths` ≈ instanceDir（路径解析根；这里给整个 PathManager）
 *  - `sessionId?` ≈ 不必命中（list_sessions / ping 之类全局命令不需要）；命中后模块自己
 *    决定要不要 `await ctx.sm.open(sessionId)` 拿 Session 实例（**不像旧版的
 *    `ctx.session` 那样由 transport 预 open**——更靠近 agenteam 的 stateless 风格）。 */
export interface ModuleContext {
  sm: SessionManager;
  paths: PathManagerAPI;
  /** 调用 query/execute 时来自前端 body 的 sessionId（forgeax = sid）。 */
  sessionId?: string;
  /** 仅记录调用方 agentId 用于审计 / 权限钩子，runner 本身不消费。 */
  requestingAgentId?: string;
}

export type CallContext = ModuleContext;

/** Spec broadcast to renderer. 与 agenteam ref `CommandSpec` 完全一致。 */
export interface CommandSpec {
  name: string;
  description: string;
  hasQuery: boolean;
  hasExecute: boolean;
}

/** Runner 包装结果：模块抛错 → { ok: false }。形状与 agenteam ref 完全一致。 */
export type CommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
