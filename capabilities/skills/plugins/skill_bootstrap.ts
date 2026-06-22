// @desc Auto-fetch missing skills from upstream marketplace on plugin start.
import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";
import {
  bootstrapMissingSkills,
  DEFAULT_SKILLS,
  DEFAULT_UPSTREAM,
  DEFAULT_UPSTREAM_BASE_PATH,
  type BootstrapConfig,
} from "../lib/skill-downloader.js";

/**
 * Defaults imported from lib (single source of truth shared with condition.ts +
 * fetch_skill tool). Runtime inline-fallback is still required because
 * BaseLoader.mergeDefaults() writes configDefaults to agent-overrides.json on
 * disk but does not reload the in-memory agentJson before plugin.start() runs
 * on the first turn, so ctx.getAgentJson() returns the pre-merge snapshot.
 */

export default function create(ctx: AgentContext): PluginSource {
  let aborted = false;

  return {
    name: "skill_bootstrap",

    start() {
      aborted = false;
      const raw = ctx.getAgentJson().capabilities?.config?.skills?.skill_bootstrap as
        | Record<string, unknown>
        | undefined;
      const config: BootstrapConfig = {
        skills: Array.isArray(raw?.skills) ? (raw.skills as string[]) : DEFAULT_SKILLS,
        upstream: typeof raw?.upstream === "string" ? raw.upstream : DEFAULT_UPSTREAM,
        upstreamBasePath:
          typeof raw?.upstreamBasePath === "string" ? raw.upstreamBasePath : DEFAULT_UPSTREAM_BASE_PATH,
      };
      if (config.skills.length === 0) return;

      // 后台异步跑，不阻塞 start；所有失败已在 lib 内部 log，这里兜底
      bootstrapMissingSkills(ctx, config, () => aborted).catch((err) => {
        console.warn("[skill_bootstrap] unexpected failure:", err?.message || err);
      });
    },

    stop() {
      aborted = true;
    },
  };
}
