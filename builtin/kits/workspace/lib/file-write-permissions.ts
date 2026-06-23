/** canWritePath —— write_file / edit_file / multi_edit / apply_patch 的统一闸门。
 *
 *  策略（**严格 allowlist**——只放行下面这些，其余一律拒）：
 *    1. agent 自身的 agentDir（memory / lessons / scenes / kit override / 进度文件）。
 *    2. 游戏工作区：
 *       - <projectRoot>/.forgeax/games/**  —— 规范路径
 *       - <projectRoot>/games/**           —— 旧版 fallback（safe-path 仍白名单）
 *    3. 其余全部拒绝，包括：
 *       - builtin（packages/server/builtin/**）
 *       - packages/** / apps/** / node_modules/** —— studio 源码，误写杀 server
 *       - **projectRoot 之外的任意路径**（父目录 / 同级 / $HOME）—— 这是关键收口：
 *         agent 不能在 `.forgeax/games/` 外面凭空建一个 standalone HTML 项目，
 *         "做游戏" 只能落进游戏工作区。
 *
 *  之前这里是「黑名单 + 其余开放」，导致 agent 可以往 projectRoot 外面（如
 *  `<repo父目录>/gomoku/index.html`）随便写——把 charter prompt 的约束架空了。
 *  现在 prompt 契约（game_charter slot / claude-code append）+ 这道硬闸门双保险。
 */

import { isAbsolute, normalize, sep, resolve as resolvePath } from "node:path";
import type { AgentContext } from "../../../../src/core/types";

function isUnder(target: string, base: string): boolean {
  const t = normalize(target);
  const b = normalize(base);
  return t === b || t.startsWith(b + sep);
}

export function canWritePath(absPath: string, ctx: AgentContext): boolean {
  if (!isAbsolute(absPath)) return false;
  const target = normalize(absPath);

  // Builtin is never writable, even if it happens to sit under agentDir.
  const builtin = ctx.pathManager.builtin().root();
  if (isUnder(target, builtin)) return false;

  // (1) The agent's own scaffold dir — memory, lessons/scenes, progress, kit
  //     overrides. Always writable.
  if (ctx.agentDir && isUnder(target, normalize(ctx.agentDir))) return true;

  // (2) Game workspaces. The canonical root is exactly the pathManager's
  //     gamesDir (= <projectRoot>/.forgeax/games) — use it DIRECTLY, no
  //     up-traversal math (a prior `gamesDir/../../..` went one level too far
  //     and anchored the allowlist at the *parent* of the project root, which
  //     denied every legitimate game write). The legacy `<projectRoot>/games`
  //     fallback derives by going up two levels from gamesDir (.forgeax/games).
  const gamesDir = ctx.pathManager.user().gamesDir();
  const projectRoot = resolvePath(gamesDir, "..", "..");
  const gameRoots = [gamesDir, resolvePath(projectRoot, "games")];
  if (gameRoots.some((g) => isUnder(target, g))) return true;

  // (3) Everything else — studio source, repo internals, and ALL paths outside
  //     the project root — is denied.
  return false;
}
