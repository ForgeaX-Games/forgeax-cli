// @desc /api/commands —— mount the (stateless) commands transport
//
// Stateless 设计：transport router 不持任何状态，从 runner 里直接扫盘。
// 命令模块住在 `packages/server/commands/<file>.ts`（不是 src/），与 agenteam
// ref 的 `commands/*.ts` 仓库根目录约定对齐。

import { Hono } from "hono";
import { createCommandsRouter } from "../commands/transport";

export function createCommandsApiRouter(): Hono {
  const r = new Hono();
  r.route("/", createCommandsRouter());
  return r;
}
