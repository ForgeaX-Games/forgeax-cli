/** attach-audio —— 下载 BGM/音效到 <game>/audio/ 并写 manifest。
 *
 *  逻辑已迁出到 marketplace 插件 @forgeax-plugin/wb-bgm。这个 builtin kit 现在
 *  是无逻辑转发器(见 search-audio.ts 说明):execute 转调 Host ToolRegistry 里
 *  的插件 attach-audio(caller.kind='ai'),由插件 handler 复用同一份逻辑。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { callTool } from "../../../../src/tools/registry";
import { ATTACH_AUDIO_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";

const tool: ToolDefinition = {
  ...ATTACH_AUDIO_SPEC,
  async execute(args) {
    const a = args as { slug?: string };
    if (!a.slug || !a.slug.trim()) {
      throw new Error("slug is required (target game; no auto-detect)");
    }
    const r = await callTool({ toolId: "attach-audio", args, caller: { kind: "ai" } });
    if (!r.ok) throw new Error(r.error);
    return JSON.stringify(r.result, null, 2);
  },
};

export default tool;
