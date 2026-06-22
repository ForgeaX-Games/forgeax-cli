/**
 * env-builder — 为 agent shell 进程构建运行时环境变量。
 *
 * Direct 模式（buildAgentShellEnv）：
 *   优先级（低 → 高）：
 *     process.env < agent.json.timezone 注入的 TZ < team/env/base.env < agent/.env
 *   PATH 在此基础上前置 homes/{agentId}/.local/bin，保证 pip install --user 等本地命令可用。
 *   在 session 创建时调用一次，env 固化到 bash 进程。
 *   AI 需要更新 env 时，在运行中的 session 里 `source .env` 或 `export KEY=VAL` 即可。
 *
 * Docker 模式（buildSandboxExecArgs）：
 *   通过 docker exec --env-file 将 base.env 和 agent/.env 传入容器。
 *   同样注入 agent.json.timezone 作为 TZ 默认值（优先级低于后续 env-file）。
 *   容器的 PATH/NODE_PATH 由镜像自带，不在此注入。
 *   HOME 显式注入为 homes/{agentId}/ 宿主机路径（容器内同路径挂载，路径相同）。
 *
 * Timezone 注入规则（agent 模式）：
 *   agent.json.timezone 字段直接注入为 shell 的 TZ 环境变量，默认值 "Asia/Shanghai"
 *   （与 src/core/conscious-agent.ts 中 CURRENT_TIME slot 的 fallback 一致）。
 *   base.env / agent .env 里的 TZ 可以 override。这让 timezone 配置在 LLM prompt
 *   与 shell 命令间保持一致，无需重复在 .env 再写一遍。
 */

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PathManagerAPI } from "../core/types.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * 同步读取 agent 的 timezone：top-level merge agent.json + agent-overrides.json
 * （timezone 是标量字段，无需 deepMerge）。读取失败或字段缺失返回默认值。
 */
function readAgentTimezoneSync(agentId: string, pathManager: PathManagerAPI): string {
  const agent = pathManager.agent(agentId);
  let base: Record<string, unknown> = {};
  try { base = JSON.parse(readFileSync(agent.config(), "utf-8")); } catch { /* agent.json missing or malformed */ }
  let overrides: Record<string, unknown> = {};
  try { overrides = JSON.parse(readFileSync(agent.configOverrides(), "utf-8")); } catch { /* overrides missing or malformed */ }
  const merged = { ...base, ...overrides };
  return typeof merged.timezone === "string" && merged.timezone.trim()
    ? merged.timezone
    : DEFAULT_TIMEZONE;
}

/**
 * 解析 .env 文件内容为 key-value 对。
 * 支持：注释行（#）、单双引号值、KEY=VALUE 格式。
 * 不支持：多行值、$VAR 展开。
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

/**
 * 为指定 agent 构建完整的 shell 进程 env（Direct 模式专用）。
 *
 * 读取顺序（低→高优先级）：
 *   1. process.env（宿主机完整环境）
 *   2. team/env/base.env（team 级共享变量）
 *   3. team/agents/{agentId}/.env（agent 私有变量，仅非系统终端读取）
 *
 * @param agentId   agent 标识符（传空或 undefined 则为系统级环境）
 * @param pathManager  路径管理器
 */
export async function buildAgentShellEnv(
  agentId: string | undefined,
  pathManager: PathManagerAPI,
): Promise<NodeJS.ProcessEnv> {
  const isSystem = !agentId;

  const baseEnvPath = join(pathManager.team().envDir(), "base.env");
  let baseEnv: Record<string, string> = {};
  try {
    const content = await readFile(baseEnvPath, "utf-8");
    baseEnv = parseEnvFile(content);
  } catch { /* base.env 不存在则跳过 */ }

  let agentDotEnv: Record<string, string> = {};
  let agentDir = "";

  if (!isSystem && agentId) {
    agentDir = pathManager.agent(agentId).root();
    try {
      const content = await readFile(pathManager.agent(agentId).envFile(), "utf-8");
      agentDotEnv = parseEnvFile(content);
    } catch { /* .env 不存在则跳过 */ }
  } else {
    agentDir = pathManager.team().root();
  }

  // agent.json.timezone 作为 TZ 默认值（仅 agent 模式），优先级低于 baseEnv / agentDotEnv
  const tzDefault: Record<string, string> = !isSystem && agentId
    ? { TZ: readAgentTimezoneSync(agentId, pathManager) }
    : {};

  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...tzDefault,
    ...baseEnv,
    ...agentDotEnv,
  };

  if (!isSystem && agentId) {
    merged.HOME = pathManager.team().homeFor(agentId);
  }

  // homes/{agentId}/.local/bin 前置，确保 pip install --user 安装的命令优先被找到
  merged.PATH = [
    ...(agentId ? [`${pathManager.team().homeFor(agentId)}/.local/bin`] : []),
    process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  ].join(":");

  return merged;
}

/**
 * 构建 `docker exec` 的 env 参数（Docker 模式专用）。
 *
 * 返回传给 docker exec 的 --env / --env-file 参数列表：
 *   --env HOME=<homes/{agentId}/ 路径>
 *   --env-file base.env（若存在）
 *   --env-file agent .env（若存在）
 *
 * 容器内的 PATH/python/node 由镜像自带，不在此注入。
 */
export function buildSandboxExecArgs(
  agentId: string,
  pathManager: PathManagerAPI,
): string[] {
  const args = [
    "--env", `HOME=${pathManager.team().homeFor(agentId)}`,
    // agent.json.timezone 作为 TZ 默认值；后面的 --env-file 中如有 TZ 会视 Docker
    // 的 后者覆盖前者 语义 override，所以 base.env / agent .env 的 TZ 保持高优先级。
    "--env", `TZ=${readAgentTimezoneSync(agentId, pathManager)}`,
  ];
  const baseEnv = join(pathManager.team().envDir(), "base.env");
  const agentEnv = pathManager.agent(agentId).envFile();
  if (existsSync(baseEnv)) args.push("--env-file", baseEnv);
  if (existsSync(agentEnv)) args.push("--env-file", agentEnv);
  return args;
}

/**
 * 即拿即用：直接从磁盘读取 base.env + agent .env 并合并，不做 PATH 处理。
 * 每次调用均读取最新文件，无需缓存或 watcher。
 * 传空 agentId 时只返回 base.env。
 */
export async function readAgentDotEnv(
  agentId: string | undefined,
  pathManager: PathManagerAPI,
): Promise<Record<string, string>> {
  let env: Record<string, string> = {};

  try {
    const content = await readFile(join(pathManager.team().envDir(), "base.env"), "utf-8");
    env = { ...env, ...parseEnvFile(content) };
  } catch { /* base.env 不存在则跳过 */ }

  if (agentId) {
    try {
      const content = await readFile(pathManager.agent(agentId).envFile(), "utf-8");
      env = { ...env, ...parseEnvFile(content) };
    } catch { /* agent .env 不存在则跳过 */ }
  }

  return env;
}
