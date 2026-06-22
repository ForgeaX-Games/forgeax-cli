// @desc Package condition + config defaults for skills
import type { AgentContext } from "#src/core/types.js";
import {
  DEFAULT_SKILLS,
  DEFAULT_UPSTREAM,
  DEFAULT_UPSTREAM_BASE_PATH,
} from "./lib/skill-downloader.js";

export default function condition(_ctx: AgentContext): boolean {
  return true;
}

/**
 * skill_bootstrap 默认从 Anthropic 官方 skill marketplace 幂等拉取指定 skill。
 * - skills: 启动时自动拉取的白名单（目录存在即 skip，不做版本/升级语义）
 * - upstream: tarball URL（可替换为其他同构源）
 * - upstreamBasePath: tarball 内 skill 子树的起始路径
 *
 * 按需拉取任意 upstream skill 用 `fetch_skill` 工具（agent 自主调用，不受 skills 白名单限制）。
 */
export const configDefaults = {
  skill_bootstrap: {
    skills: DEFAULT_SKILLS,
    upstream: DEFAULT_UPSTREAM,
    upstreamBasePath: DEFAULT_UPSTREAM_BASE_PATH,
  },
};
