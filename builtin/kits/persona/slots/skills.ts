/** skills slot —— 把当前 agent **独有**的 skill 列表（agent.defaultSkills）
 *  注入 prompt，让 LLM 知道自己有哪些工具可用。
 *
 *  设计要点：
 *   - "独有"通过 plugin manifest 的 `provides.agent.defaultSkills` 声明：列在
 *     里面就是这个 agent 拥有，不在就不展示。区别于 workspace/environment 的
 *     **全局** skill 表（那个列的是所有装好的 skill）。
 *   - agent ID 从 `ctx.agentPath.split('/').pop()` 取最后一段（forgeax 约定的
 *     agent 文件夹名 == agent id）。lookupAgent 失败 → 静默返回空串（root /
 *     未注册 agent）。
 *   - prompt-kind skill 的 body 由 composeSystemPrompt 走 claude-code provider
 *     时已经全文 inline 过；slot 路径下走的是 forgeax-native agent，prompt-kind
 *     的 body 也由 SkillRunner 在调用时注入，所以这里只列「目录」而不重复正文。
 *   - cacheHint='stable' + STATIC_CORE：与 persona / memory 同档，相对 invariant。
 *     manifest 改动需要重启服务才生效（plugin registry 是 process-singleton），
 *     这里不必 fs.watch。
 */

import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { lookupAgent, resolveSkill } from "../../../../src/agents/loader";
import { pickI18n } from "@forgeax/types";
import type { SkillRef } from "@forgeax/types";

function lastSegment(agentPath: string): string {
  const segs = agentPath.split("/");
  return segs[segs.length - 1] ?? agentPath;
}

export default function skillsSlot(_ctx: AgentContext): ContextSlot | null {
  return {
    name: "skills",
    description:
      "Inject the agent's own skill index from plugin manifest's " +
      "`provides.agent.defaultSkills`, regardless of skill kind. ts/py " +
      "skills are listed by id+description (invoke via the `skill` tool); " +
      "prompt skills are also listed here, with full body injected by " +
      "SkillRunner on demand.",
    priority: SlotPriority.STATIC_CORE,
    cacheHint: "stable",
    version: 1,
    content: () => {
      const agentId = lastSegment(_ctx.agentPath);
      const entry = lookupAgent(agentId);
      if (!entry) return "";
      const refs = (entry.definition.defaultSkills ?? []) as SkillRef[];
      if (refs.length === 0) return "";
      const lang = entry.definition.defaultLang ?? "zh";
      const lines: string[] = [];
      for (const r of refs) {
        const sk = resolveSkill(r, entry.pluginId);
        if (!sk) continue;
        const sd = sk.definition;
        const desc =
          pickI18n(sd.description, lang) || pickI18n(sd.displayName, lang) || "";
        lines.push(`- \`${sd.id}\` (${sd.entry.kind})${desc ? ` — ${desc}` : ""}`);
      }
      if (lines.length === 0) return "";
      return [
        "# Your Skills",
        "",
        ...lines,
        "",
        "Invoke ts/py skills via the `skill` tool. Prompt skills are mounted " +
        "inline by SkillRunner when triggered.",
      ].join("\n");
    },
    condition: (ctx) => {
      const agentId = lastSegment(ctx.agentPath);
      const entry = lookupAgent(agentId);
      if (!entry) return false;
      return (entry.definition.defaultSkills ?? []).length > 0;
    },
  };
}
