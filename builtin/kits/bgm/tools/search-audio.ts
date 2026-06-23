/** search-audio —— 在 Local 库搜索 BGM/音效。
 *
 *  逻辑已迁出到 marketplace 插件 @forgeax-plugin/wb-bgm（server/tool-handlers.ts
 *  + src/core.ts）。这个 builtin kit 现在是一层**无逻辑转发器**:它的作用是让
 *  「每个 native agent 都默认能用 bgm」（host_tool_bridge 是 opt-in/deny-all,
 *  不给每个 agent 白名单的话拿不到),execute 直接转调 Host ToolRegistry 里的
 *  插件工具(caller.kind='ai'),由插件 handler 复用同一份逻辑 + env/cwd 注入。
 *  spec(name/desc/schema)仍来自共享的 tool-specs(纯数据)。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { callTool } from "../../../../src/tools/registry";
import { SEARCH_AUDIO_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";

const tool: ToolDefinition = {
  ...SEARCH_AUDIO_SPEC,
  async execute(args) {
    const r = await callTool({ toolId: "search-audio", args, caller: { kind: "ai" } });
    if (!r.ok) throw new Error(r.error);
    return JSON.stringify(r.result, null, 2);
  },
};

export default tool;
