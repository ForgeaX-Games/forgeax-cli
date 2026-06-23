/** 首次运行 scaffolding —— 补齐 `~/.forgeax/key/models.json`。
 *
 *  llm_key.json 已退役（2026-05）：所有 API 凭证从 $ROOT/.env 读取，路由由
 *  src/llm/auto-resolver.ts 按 model id 模式 + .env 自动决定。
 *
 *  约束：
 *  - 只补缺，不覆盖：用户改过的 models.json 永远不动。
 *  - copy 自源码仓库的 packages/server/src/defaults/models.json。
 *  - agent.json 不走 copy 路径 —— 由 SessionManager.create / spawn_subagent 把
 *    AGENT_DEFAULTS 与调用方参数 deep-merge 后写盘。 */

import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathManagerAPI } from "../fs/types";

/** 当前文件所在目录。Bun + Node 双兼容（Bun 有 import.meta.dir，Node 有 import.meta.url）。 */
function defaultsDir(): string {
  const dir = (import.meta as unknown as { dir?: string }).dir;
  if (typeof dir === "string") return dir;
  return dirname(fileURLToPath(import.meta.url));
}

export interface ScaffoldResult {
  /** 实际 copy 过去的相对文件名集合（已存在的不计）。 */
  created: string[];
}

export async function ensureUserDirDefaults(pm: PathManagerAPI): Promise<ScaffoldResult> {
  const keyDir = pm.user().keyDir();
  await mkdir(keyDir, { recursive: true });

  const seedDir = defaultsDir();
  const created: string[] = [];

  const targets: Array<{ name: string; src: string; dst: string }> = [
    { name: "models.json", src: resolve(seedDir, "models.json"), dst: pm.user().modelsFile() },
  ];

  for (const t of targets) {
    if (existsSync(t.dst)) continue;
    await copyFile(t.src, t.dst);
    created.push(t.name);
  }

  return { created };
}
