/** Shared wb-bgm agent tool specs (name + description + input schema), pure
 *  data. The wb-bgm LOGIC moved to the marketplace plugin (@forgeax-plugin/
 *  wb-bgm); these specs remain server-side only so the two GLOBAL exposure
 *  forwarders can name/describe the tools without re-declaring schemas:
 *    - builtin/kits/bgm/tools/* (native agents) spread a spec and add `execute`
 *      that forwards to the plugin via the Host ToolRegistry (callTool).
 *    - the stdio MCP server (cli-providers/mcp/forgeax-tools-server.mjs) maps a
 *      spec to { inputSchema } and adds `run` that POSTs /api/tools/call
 *      (external CLI providers: cursor-agent / claude-code / codex).
 *  Keep this module dependency-free (plain data) so the .mjs MCP server can
 *  import it without dragging in server runtime modules. */

export interface BgmToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const SEARCH_AUDIO_SPEC: BgmToolSpec = {
  name: "search-audio",
  description:
    "在 Local 库搜索 BGM(kind=bgm)/音效(kind=sfx),按 tag 匹配。query 与 kind 均必填:" +
    "query 传单个英文单词(小写 tag,如 battle / click),kind 传 bgm 或 sfx。返回 " +
    "{ assetId, name, kind, version, resUrl } 列表;assetId + resUrl 用于后续 attach-audio。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "单个英文单词(tag,小写),必填,如 battle / click / jump" },
      kind: { type: "string", enum: ["bgm", "sfx"], description: "音频类型(必填):bgm=背景音乐, sfx=音效" },
      limit: { type: "number", description: "返回条数,缺省 20,1..200" },
    },
    required: ["query", "kind"],
  },
};

export const ATTACH_AUDIO_SPEC: BgmToolSpec = {
  name: "attach-audio",
  description:
    "把一条 BGM/音效下载到 .forgeax/games/<slug>/audio/ 并 upsert 到 audio/manifest.json" +
    "(按 assetId 幂等)。assetId/resUrl/name/version 取自 search-audio 的结果,勿编造 resUrl。" +
    "slug 必填:必须显式传入目标游戏的 slug。",
  input_schema: {
    type: "object",
    properties: {
      assetId: { type: "string", description: "资产 id(来自 search-audio)" },
      kind: { type: "string", enum: ["bgm", "sfx"], description: "bgm 或 sfx" },
      resUrl: { type: "string", description: "COS 下载地址(来自 search-audio,勿编造)" },
      name: { type: "string", description: "曲目名;sfx 建议用稳定短名(如 hit/score)" },
      version: { type: "string", description: "版本号(来自 search-audio)" },
      slug: { type: "string", description: "目标游戏 slug(必填):必须显式传入,不自动探测" },
      filename: { type: "string", description: "落盘文件名;缺省从 name/url 推导" },
    },
    required: ["assetId", "kind", "resUrl", "slug"],
  },
};

export const LIST_AUDIO_SPEC: BgmToolSpec = {
  name: "list-audio",
  description:
    "读取 .forgeax/games/<slug>/audio/manifest.json,返回已配入的 BGM/音效清单。" +
    "slug 必填(必须显式传入目标游戏)。配 audio 前先调它,避免重复附加。",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "目标游戏 slug(必填):必须显式传入,不自动探测" },
    },
    required: ["slug"],
  },
};

/** All wb-bgm tool specs, in catalog order. */
export const BGM_TOOL_SPECS: BgmToolSpec[] = [SEARCH_AUDIO_SPEC, ATTACH_AUDIO_SPEC, LIST_AUDIO_SPEC];
