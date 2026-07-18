#!/usr/bin/env node
/** forgeax tools MCP server (stdio) — M3 机制证明。
 *
 *  把「编排层声明的 forgeax 工具」暴露给 the reference agent CLI(经 `--mcp-config`)。
 *  CC 把它们当 `mcp__fxt__<tool>` 调用;编排层用 `--allowedTools` 显式放行
 *  (= 权限归编排层),所以 headless 也能调、不卡审批。
 *
 *  M3 先内置一个 `echo` 演示工具,跑通「编排声明 → MCP 下发 → CC 调用 →
 *  工具事件经内核回流」整条路。真实工具(读世界 / 跑 forgeax kit)走 HTTP 回调
 *  server 执行,是下一步(M3b)。
 *
 *  Plain Node + JSON-RPC-over-stdio(无 SDK 依赖),与 permission-server.mjs 同构。
 *
 *  ── P2-14 对外驱动面(standalone / 任意 MCP client 驱动 Studio)──────────
 *  本进程可脱离内核 profile 独立起,给任何 MCP client(IDE / 另一个 agent CLI)
 *  当「驱动运行中 Studio」的标准入口:
 *
 *    FORGEAX_SERVER_URL=http://localhost:18900 FORGEAX_SID=<sid> \
 *      node src/kernel/mcp/forgeax-tools-server.mjs
 *
 *  (mcp-config 形态即 command+env 同上;工具以 mcp__fxt__* 出现。)
 *  收口环境变量:
 *    FORGEAX_FXT_EXPOSE=ui_snapshot,ui_invoke,ui_screenshot   只暴露白名单内工具
 *      (外部驱动面建议只开 ui_*;留空 = 全量,内核 profile 路径的历史行为)。
 *    FORGEAX_DISABLE_PERCEPTION=1 / FORGEAX_DISABLE_UI_BRIDGE=1  整类摘除。
 *  安全边界:本进程只有「查询/调用」两类工具;ui-lease / ui-manifest 写端点
 *  (权限闸的信任锚)**刻意不在** MCP 面上,外部 client 无法改写权限声明。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEBUG = process.env.FORGEAX_CC_MCP_DEBUG;
const dbg = (m) => { if (DEBUG) { try { appendFileSync('/tmp/forgeax-cc-mcp.log', `${new Date().toISOString()} [tools] ${m}\n`); } catch {} } };
const PROJECT_ROOT = process.env.FORGEAX_PROJECT_ROOT || process.cwd();
const SOUL_AGENT = process.env.FORGEAX_SOUL_AGENT || 'default';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// ── T-A host-tool 桥:回调宿主执行 agent 的真实 host-tools ───────────────
const SERVER_URL = (process.env.FORGEAX_SERVER_URL || '').replace(/\/$/, '');
const BRIDGE_SID = process.env.FORGEAX_SID || '';
const BRIDGE_AGENT = process.env.FORGEAX_AGENT || '';
const SPECS_FILE = process.env.FORGEAX_TOOL_SPECS_FILE || '';

/** 从 specs 文件读非内置工具规格(name/description/inputSchema)。 */
function loadBridgedSpecs() {
  if (!SPECS_FILE || !existsSync(SPECS_FILE)) return [];
  try {
    const arr = JSON.parse(readFileSync(SPECS_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr.filter((t) => t && typeof t.name === 'string') : [];
  } catch { return []; }
}
const BRIDGED = loadBridgedSpecs();

// 桥超时:多数 host-tool 是毫秒级,但 delegate_to_subagent 同步 scaffold 子 agent
// 可达 ~5s(waitForTreeNode 5s + grace)→ 留足 90s 上限,既不卡死 CC 又容纳慢工具。
const BRIDGE_TIMEOUT_MS = 90_000;

/** 桥接调用:HTTP POST 回宿主 /api/sessions/:sid/kernel-tool;带超时;fail-closed。 */
async function bridgeCall(toolName, args) {
  if (!SERVER_URL || !BRIDGE_SID) return { isError: true, text: 'bridge unavailable (no server url / sid)' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(BRIDGE_SID)}/kernel-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentPath: BRIDGE_AGENT, toolName, args: args ?? {} }),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      return { isError: true, text: String(body?.error ?? `bridge HTTP ${res.status}`) };
    }
    const r = body.result;
    return { isError: false, text: typeof r === 'string' ? r : JSON.stringify(r ?? '') };
  } catch (e) {
    const msg = ac.signal.aborted ? `bridge timeout after ${BRIDGE_TIMEOUT_MS}ms (tool ${toolName})` : `bridge transport error: ${e?.message ?? e}`;
    return { isError: true, text: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ── 感知接地(R5/M8):query_world / capture_frame 的真实后端 ────────────
// 这两个内置工具不在本进程取数(真值在浏览器里的 preview iframe),而是 HTTP 回打
// server 的 /:sid/perception-query;server 经 WS 让 interface 去 preview iframe 取真值,
// 拿到后回灌解开。镜像 bridgeCall 的 fetch+timeout 写法。
const PERCEPTION_TIMEOUT_MS = 12_000;
async function perceptionQuery(kind, query) {
  if (!SERVER_URL || !BRIDGE_SID) return { unavailable: true, reason: 'no server url / sid' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PERCEPTION_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(BRIDGE_SID)}/perception-query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, query: query ?? null, agent: BRIDGE_AGENT }),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    return body?.snapshot ?? { unavailable: true, reason: `perception HTTP ${res.status}` };
  } catch (e) {
    return { unavailable: true, reason: ac.signal.aborted ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── R6 数字生命:memory_search 的真实后端 ──────────────────────────────
// 这是独立 node 子进程(CC 经 --mcp-config spawn),无打包器 → 无法 import 服务端 TS。
// 故在此**镜像** `src/soul/layered-memory.ts` 的检索逻辑(纯 FS · 朴素关键词 · 无 RAG)。
// 改检索口径时两处需同步。
function soulMemoryRoot() {
  const safe = SLUG_RE.test(SOUL_AGENT) ? SOUL_AGENT : 'default';
  return join(PROJECT_ROOT, '.forgeax/souls', safe, 'memory');
}
function readLayerFiles(root, tier, game) {
  const dir = tier === 'episodes' && game ? join(root, 'episodes', game) : join(root, tier);
  if (tier === 'episodes' && !game) return [];
  const out = [];
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'memory.md').sort(); } catch { return []; }
  for (const f of names) {
    let body = '';
    try { body = readFileSync(join(dir, f), 'utf-8').trim(); } catch { continue; }
    if (!body) continue;
    const rel = tier === 'episodes' && game ? `episodes/${game}/${f}` : `${tier}/${f}`;
    out.push({ tier, game: tier === 'episodes' ? game : undefined, file: rel, body });
  }
  return out;
}
// ── R6 数字生命:remember 写入(模型驱动成长)—— 镜像 layered-memory.ts 的写时分类 + 索引 ──
function activeGame() {
  try {
    const p = join(PROJECT_ROOT, '.forgeax/active-game.json');
    if (!existsSync(p)) return undefined;
    const slug = JSON.parse(readFileSync(p, 'utf-8'))?.slug;
    return typeof slug === 'string' && SLUG_RE.test(slug) ? slug : undefined;
  } catch { return undefined; }
}
function slugify(s) {
  return (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)) || 'entry';
}
function rebuildIndex(root) {
  const lines = [];
  const add = (sections) => { for (const m of sections) {
    const first = m.body.split(/\r?\n/).find((l) => l.trim()) ?? '';
    const tag = m.game ? `${m.tier}:${m.game}` : m.tier;
    lines.push(`- [${tag}] ${m.file} — ${first.replace(/^#+\s*/, '').slice(0, 120)}`);
  } };
  add(readLayerFiles(root, 'identity')); add(readLayerFiles(root, 'traits'));
  try { for (const g of readdirSync(join(root, 'episodes')).sort()) if (SLUG_RE.test(g)) add(readLayerFiles(root, 'episodes', g)); } catch {}
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'MEMORY.md'), `# MEMORY index\n\n> 常驻索引:每条一行。模型据此挑文件 Read 召回(纯 FS,无 RAG)。\n\n${lines.join('\n')}\n`);
}
/** 写一条记忆:general→traits;game→episodes/<当前game>;无 kind+有 game→episodes,否则 traits。 */
function rememberMemory(args) {
  const text = String(args?.text ?? '').trim();
  if (!text) return { ok: false, error: 'remember: empty text' };
  const kind = args?.kind === 'general' || args?.kind === 'game' ? args.kind : undefined;
  const game = activeGame();
  const toTraits = kind === 'general' || (kind !== 'game' && !game);
  const tier = toTraits ? 'traits' : 'episodes';
  if (tier === 'episodes' && !game) return { ok: false, error: 'remember: game-bound memory needs an active game' };
  const root = soulMemoryRoot();
  const dir = tier === 'episodes' ? join(root, 'episodes', game) : join(root, tier);
  mkdirSync(dir, { recursive: true });
  const base = slugify(args?.title ?? text);
  let name = `${base}.md`, n = 2;
  while (existsSync(join(dir, name))) name = `${base}-${n++}.md`;
  writeFileSync(join(dir, name), `${args?.title ? `# ${args.title}\n\n` : ''}${text}\n`);
  rebuildIndex(root);
  const rel = tier === 'episodes' ? `episodes/${game}/${name}` : `${tier}/${name}`;
  return { ok: true, tier, ...(tier === 'episodes' ? { game } : {}), file: rel };
}

function searchMemory(query, limit = 5) {
  const root = soulMemoryRoot();
  const all = [...readLayerFiles(root, 'identity'), ...readLayerFiles(root, 'traits')];
  try { for (const g of readdirSync(join(root, 'episodes'))) if (SLUG_RE.test(g)) all.push(...readLayerFiles(root, 'episodes', g)); } catch {}
  const q = String(query || '').toLowerCase().trim();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  const scored = all.map((m) => {
    const hay = m.body.toLowerCase();
    let score = hay.includes(q) ? 5 : 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    return { m, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return {
    query: String(query || ''),
    matches: scored.map(({ m }) => ({ tier: m.tier, ...(m.game ? { game: m.game } : {}), file: m.file, text: m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body })),
  };
}

/** 列出工作区里的游戏(`.forgeax/games/` + 兼容旧 `games/`),过滤 _template / 隐藏。 */
function listGames() {
  const out = [];
  for (const base of [join(PROJECT_ROOT, '.forgeax/games'), join(PROJECT_ROOT, 'games')]) {
    if (!existsSync(base)) continue;
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')) out.push(e.name);
      }
    } catch {}
  }
  return [...new Set(out)];
}

/** 内置工具表。echo = 机制 demo;list_games = 真实只读 forgeax 能力(读文件系统)。
 *  需 kit-ctx 的真实工具(写世界/跑 kit)走 HTTP 回调 server,后续接入。 */
const TOOLS = {
  echo: {
    spec: {
      name: 'echo',
      description: 'Echo back the given text. A forgeax demo tool to verify MCP tool delivery.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    run: (args) => `[forgeax_echo] ${String(args?.text ?? '')}`,
  },
  list_games: {
    spec: {
      name: 'list_games',
      description: 'List the game projects in this forgeax workspace (under .forgeax/games/). Returns { count, games }.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: () => { const games = listGames(); return JSON.stringify({ count: games.length, games }); },
  },
  // 数字生命(R6)按需召回通道 —— 真实后端 = soul 分层记忆库(identity/traits/episodes,
  // 含前世 game)。纯 FS · 朴素关键词 · 无 RAG(规格:模型驱动检索)。
  memory_search: {
    spec: {
      name: 'memory_search',
      description: "Search your long-term layered memory (identity / traits / episodes, including past-life worlds) for relevant entries. Returns { query, matches:[{tier, game?, file, text}] }.",
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    run: (args) => JSON.stringify(searchMemory(args?.query ?? '')),
  },
  // 数字生命(R6)成长通道 —— 模型驱动写入:agent 自己决定记什么。general→traits(可移植),
  // game→episodes/<当前game>;写时分类 + 维护 MEMORY.md 索引。真实后端 = soul 分层记忆库。
  remember: {
    spec: {
      name: 'remember',
      description: "Persist a durable memory about the user or this game into your long-term layered memory so you recall it in future sessions. Use kind:'general' for portable facts about the user (carry across games), kind:'game' for facts bound to the current game world. Returns { ok, tier, game?, file }.",
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['general', 'game'] }, title: { type: 'string' } }, required: ['text'] },
    },
    run: (args) => JSON.stringify(rememberMemory(args)),
  },
  // 感知接地(R5/M8)—— 向运行中的游戏取真值。仅取数,裁判 = 模型 + 结构/不变量。
  query_world: {
    spec: {
      name: 'query_world',
      description: "Query the RUNNING game's live world for ground truth: a structural ECS snapshot { entityCount, archetypes:[{componentNames, entityCount}], activeComponents, systems, resourceKeys }. Use it to VERIFY what the game actually contains/does (e.g. after writing code) instead of guessing. Data only — you are the judge. Returns the snapshot (or { unavailable } if no preview is open).",
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    run: async (args) => JSON.stringify(await perceptionQuery('world', args?.query)),
  },
  capture_frame: {
    spec: {
      name: 'capture_frame',
      description: 'Capture the running game preview current rendered frame as a PNG data URL (best-effort; may be blank on some GPUs — judge by structure/invariants, not pixels). Returns { bytes, dataUrl(truncated) } or { unavailable }.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: async () => {
      const snap = await perceptionQuery('frame');
      const dataUrl = snap && typeof snap === 'object' && typeof snap.dataUrl === 'string' ? snap.dataUrl : '';
      if (!dataUrl) return JSON.stringify({ unavailable: true, reason: snap?.reason ?? 'no frame' });
      return JSON.stringify({ bytes: dataUrl.length, dataUrl: dataUrl.slice(0, 64) + '…' });
    },
  },
};

// FORGEAX_DISABLE_PERCEPTION=1 → omit the perception tools (query_world /
// capture_frame) from this server entirely. Set by the codebuddy (cbc) kernel:
// cbc carries a ~20x larger baseline context than cc and defers MCP tools behind
// ToolSearch, so the agent reflexively calling query_world (then waiting on an
// unavailable preview) stacks model round-trips into a 60-90s "stuck" turn. cc /
// forgeax-core keep perception (they're light enough). See cbc-profile.ts.
if (process.env.FORGEAX_DISABLE_PERCEPTION === '1') {
  delete TOOLS.query_world;
  delete TOOLS.capture_frame;
}

// ── UI 语义操作层(产品 AI 化 P0):ui_snapshot / ui_invoke / ui_screenshot ──
// 契约 SSOT = ../ui-bridge-contract.json(与 compose-turn-request.ts 共读同一文件,
// 各内核看到字节一致的工具说明)。
// 执行**必须经 bridgeCall → 宿主 /:sid/kernel-tool**,而不是像 world/frame 那样
// 直打 /:sid/perception-query:ui_invoke 能触达 delete 级 action(如删会话),必须过
// 宿主的 per-action 信任闸(checkKernelTool + 审批卡)。kernel-tool 里
// runForgeaxBuiltinTool(ui_*) 再做真正的 perception 往返 + headless 回落。这样
// 租用内核路径与 forgeax-core 原生路径共用同一道闸(对称)。ui-lease / ui-manifest
// 两个写端点仍刻意不进 MCP 面(信任锚不外放)。
const UI_CONTRACT = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../ui-bridge-contract.json', import.meta.url), 'utf-8'));
  } catch (e) {
    dbg(`ui-bridge contract load failed: ${e?.message ?? e}`);
    return { tools: [] };
  }
})();
for (const spec of UI_CONTRACT.tools ?? []) {
  if (spec?.name === 'ui_snapshot') {
    // ui_snapshot 只读,但仍走 kernel-tool 以复用同一执行口(read → 信任闸直放)。
    TOOLS.ui_snapshot = { spec, run: async (args) => (await bridgeCall('ui_snapshot', args ?? {})).text };
  } else if (spec?.name === 'ui_invoke') {
    TOOLS.ui_invoke = {
      spec,
      run: async (args) =>
        (await bridgeCall('ui_invoke', { actionId: args?.actionId ?? null, args: args?.args ?? {} })).text,
    };
  } else if (spec?.name === 'ui_screenshot') {
    // ui_screenshot(P3)只读兜底证据,同 ui_snapshot 走 kernel-tool 闸。宿主成功时
    // 回 ContentPart 数组([{type:'image',data,mimeType},{type:'text',text:meta}]),
    // 这里翻成 MCP image content block(base64 不当文本喂模型);其余形状(unavailable /
    // captured:false)原样文本透传。
    TOOLS.ui_screenshot = {
      spec,
      run: async (args) => {
        const r = await bridgeCall('ui_screenshot', args ?? {});
        if (r.isError) return r.text;
        try {
          const parts = JSON.parse(r.text);
          // 守卫不绑定 image 在数组中的位置(§2.5:勿硬编码生产端形状),只认「存在一枚
          // 带 string data 的 image part」;下方 map 逐项按 p.type 处理,与顺序无关。
          if (Array.isArray(parts) && parts.some((p) => p?.type === 'image' && typeof p?.data === 'string')) {
            return {
              content: parts.map((p) =>
                p.type === 'image'
                  ? { type: 'image', data: p.data, mimeType: p.mimeType ?? 'image/png' }
                  : { type: 'text', text: String(p.text ?? '') },
              ),
            };
          }
        } catch {
          /* 非 JSON → 按文本透传 */
        }
        return r.text;
      },
    };
  }
}
// FORGEAX_DISABLE_UI_BRIDGE=1 → 整体摘除 ui_* 工具(per-kernel profile 开关,同
// FORGEAX_DISABLE_PERCEPTION 的先例:等 UI 往返的工具在重上下文内核上会反射式滥调)。
if (process.env.FORGEAX_DISABLE_UI_BRIDGE === '1') {
  delete TOOLS.ui_snapshot;
  delete TOOLS.ui_invoke;
  delete TOOLS.ui_screenshot;
}

// P2-14 对外驱动面收口:FORGEAX_FXT_EXPOSE=名单(逗号分隔)→ 只保留白名单内工具。
// 外部 MCP client 驱动 Studio 时建议只开 ui_*(见文件头);留空 = 全量(内核 profile
// 路径零回归)。
const EXPOSE = (process.env.FORGEAX_FXT_EXPOSE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (EXPOSE.length > 0) {
  const keep = new Set(EXPOSE);
  for (const name of Object.keys(TOOLS)) {
    if (!keep.has(name)) delete TOOLS[name];
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { let m; try { m = JSON.parse(line); } catch { continue; } handle(m); }
  }
});

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fxt', version: '0.1.0' },
    } });
  } else if (method === 'notifications/initialized') {
    /* no response */
  } else if (method === 'tools/list') {
    // 内置工具 + 桥接(host-tool)工具规格。
    const builtin = Object.values(TOOLS).map((t) => t.spec);
    const bridged = BRIDGED.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    send({ jsonrpc: '2.0', id, result: { tools: [...builtin, ...bridged] } });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const tool = TOOLS[name];
    dbg(`call ${name} ${JSON.stringify(args)}`);
    if (tool) {
      // 内置工具:本地执行(支持 sync 或 async run —— query_world/capture_frame 走 HTTP 取数)。
      // run 返回 { content: [...] } → 原样作 MCP result(ui_screenshot 回 image block);
      // 其余返回值按文本包一层(既有工具零回归)。
      Promise.resolve()
        .then(() => tool.run(args))
        .then((out) => {
          const result = out && typeof out === 'object' && Array.isArray(out.content)
            ? { content: out.content }
            : { content: [{ type: 'text', text: String(out) }] };
          send({ jsonrpc: '2.0', id, result });
        })
        .catch((e) => {
          send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `error: ${e?.message ?? e}` }] } });
        });
      return;
    }
    // host-tool:桥回宿主执行(异步;fail-closed)。
    bridgeCall(name, args).then((r) => {
      send({ jsonrpc: '2.0', id, result: { ...(r.isError ? { isError: true } : {}), content: [{ type: 'text', text: r.text }] } });
    });
  } else if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}

dbg('mcp forgeax-tools server up');
