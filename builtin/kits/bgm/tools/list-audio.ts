/** list-audio —— 读取指定游戏 audio/manifest.json(已配入的 BGM/音效清单)。
 *
 *  逻辑已迁出到 marketplace 插件 @forgeax-plugin/wb-bgm。这个 builtin kit 现在
 *  是无逻辑转发器(见 search-audio.ts 说明):execute 转调 Host ToolRegistry 里
 *  的插件 list-audio(caller.kind='ai')。slug 必填:必须显式传入目标游戏。 */

import type { ToolDefinition } from "../../../../src/core/types";
import { callTool } from "../../../../src/tools/registry";
import { LIST_AUDIO_SPEC } from "../../../../src/lib/wb-bgm/tool-specs";

const tool: ToolDefinition = {
  ...LIST_AUDIO_SPEC,
  async execute(args) {
    const a = args as { slug?: string };
    if (!a.slug || !a.slug.trim()) {
      throw new Error("slug is required (target game; no auto-detect)");
    }
    const r = await callTool({ toolId: "list-audio", args, caller: { kind: "ai" } });
    if (!r.ok) throw new Error(r.error);
    return JSON.stringify(r.result, null, 2);
  },
};

export default tool;
