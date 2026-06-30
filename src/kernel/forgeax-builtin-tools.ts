/**
 * forgeax-builtin-tools —— forgeax-core 原生内核路径下「编排层声明的内置 forgeax 工具」
 * 的宿主侧执行实现。
 *
 * 背景(本模块要补的洞):`compose-turn-request.ts` 的 `FORGEAX_TOOLS`
 * (`list_games` / `memory_search` / `remember` / `query_world` / `capture_frame`,外加
 * `echo` demo)把工具 **schema 出墙给模型**;但它们的**执行实现**此前只活在
 * cc/cbc/codex 用的 MCP stdio server `forgeax-tools-server.mjs` 里。forgeax-core 内核
 * (现为默认内核)不经那层 MCP——它把所有 host 工具经 `hostTool` 桥回宿主 →
 * `executeTool` 查 agent 的 kit 注册表,而这些内置工具不在 kit 注册表里 →
 * 返回 `{ error: "Unknown tool: remember" }`(模型以为记住了,实际没落盘)。
 *
 * 本模块在宿主侧补上同一批工具的实现,**与 .mjs 同构**:memory 直接复用
 * `soul/layered-memory.ts` 这份 TS SSOT(不再镜像检索/写盘逻辑),感知接地复用
 * `perception-registry` 的取数往返。`host-tool-bridge` 与 `:sid/kernel-tool` 两个
 * host 工具执行口都在「信任闸放行后、executeTool 前」先问本模块。
 *
 * 注:cc/cbc/codex 内核仍在 `.mjs` 里本地执行这批工具(从不桥回 `:sid/kernel-tool`),
 * 故本模块只对 forgeax-core 路径生效,不改其它内核行为。改检索/写盘口径时,
 * `layered-memory.ts`(TS SSOT,本模块用)与 `forgeax-tools-server.mjs`(.mjs 镜像)两处需同步。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Event } from '../core/types';
import type { LayeredMemoryRef } from '../soul/types';
import { soulMemoryRoot, searchMemory, classifyAndWrite } from '../soul';
import { registerPerception } from '../api/lib/perception-registry';

/** 仅需 publish 的最小事件发布口(`EventBus` 类 / 绑定 bus / 测试桩皆满足)。 */
export interface EventPublisher {
  publish(event: Event, emitterId?: string): void;
}

/** 内置 forgeax 工具名集合(与 compose-turn-request 的 FORGEAX_TOOLS + .mjs TOOLS 对齐)。 */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'echo',
  'list_games',
  'memory_search',
  'remember',
  'query_world',
  'capture_frame',
]);

/** 该工具是否为内置 forgeax 工具(宿主侧有实现,不查 agent kit 注册表)。 */
export function isForgeaxBuiltinTool(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/** 内置工具执行上下文(显式声明的输入,Pipeline Isolation)。 */
export interface BuiltinToolCtx {
  /** 工作区根(.forgeax/games · souls 解析基准)。 */
  projectRoot: string;
  /** soul 记忆库归属 agent(= 本轮 agentPath);决定 `.forgeax/souls/<agentId>/memory`。 */
  agentId: string;
  /** 本会话绑定 / 当前激活的游戏 slug。`remember kind:'game'` 与 episodes 召回按此隔离;
   *  缺省 = 通用上下文(game-bound 记忆将拒写)。 */
  game?: string;
  /** 感知接地工具(query_world/capture_frame)的会话总线;缺省则降级为 unavailable。 */
  eventBus?: EventPublisher;
}

const PERCEPTION_TIMEOUT_MS = 8_000;

function memoryRef(ctx: BuiltinToolCtx): LayeredMemoryRef {
  return { root: soulMemoryRoot(ctx.projectRoot, ctx.agentId), ...(ctx.game ? { game: ctx.game } : {}) };
}

/** 列出工作区里的游戏(`.forgeax/games/` + 兼容旧 `games/`),过滤 _template / 隐藏。 */
function listGames(projectRoot: string): { count: number; games: string[] } {
  const out: string[] = [];
  for (const base of [join(projectRoot, '.forgeax/games'), join(projectRoot, 'games')]) {
    if (!existsSync(base)) continue;
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')) out.push(e.name);
      }
    } catch {
      /* unreadable dir → skip */
    }
  }
  const games = [...new Set(out)];
  return { count: games.length, games };
}

/** 写一条记忆(模型驱动成长):general→traits(可移植);game→episodes/<当前game>;
 *  无 kind 时有 game→episodes、否则→traits。失败返回 `{ ok:false, error }`(由调用方翻成 isError)。 */
function remember(ctx: BuiltinToolCtx, args: Record<string, unknown> | undefined): unknown {
  const text = String(args?.text ?? '').trim();
  if (!text) return { ok: false, error: 'remember: empty text' };
  const kind = args?.kind === 'general' || args?.kind === 'game' ? (args.kind as 'general' | 'game') : undefined;
  if (kind === 'game' && !ctx.game) return { ok: false, error: 'remember: game-bound memory needs an active game' };
  const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
  const written = classifyAndWrite(memoryRef(ctx), [{ text, ...(kind ? { kind } : {}), ...(title ? { title } : {}) }]);
  if (!written.length) return { ok: false, error: 'remember: nothing written (no active game for game-bound memory)' };
  const w = written[0]!;
  return { ok: true, tier: w.tier, ...(w.game ? { game: w.game } : {}), file: w.file };
}

/** 感知接地取数往返:发 perception:query 给前端(经 EventBus)→ 注册阻塞 Promise →
 *  前端取 preview iframe 真值后 POST /perception-reply 解开;超时 fail-soft 返回 unavailable。
 *  镜像 `:sid/perception-query` 路由,在 forgeax-core in-process 路径里复用同一 registry。 */
async function perceptionQuery(ctx: BuiltinToolCtx, kind: 'world' | 'frame', query?: unknown): Promise<unknown> {
  if (!ctx.eventBus) return { unavailable: true, reason: 'no event bus' };
  const reqId = randomUUID();
  ctx.eventBus.publish(
    {
      type: 'perception:query',
      ts: Date.now(),
      source: `agent:${ctx.agentId}`,
      payload: { reqId, kind, query: query ?? null, agent: ctx.agentId },
    },
    ctx.agentId,
  );
  const handle = registerPerception(reqId, PERCEPTION_TIMEOUT_MS);
  try {
    return await handle.promise;
  } finally {
    handle.dispose();
  }
}

/** 执行一个内置 forgeax 工具。调用方须先确认 `isForgeaxBuiltinTool(name)` 且信任闸已放行。
 *  返回值与工具 schema 描述一致(对象;调用方负责审计 + 把 `{error}` 翻成 isError)。 */
export async function runForgeaxBuiltinTool(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: BuiltinToolCtx,
): Promise<unknown> {
  switch (name) {
    case 'echo':
      return { text: `[forgeax_echo] ${String(args?.text ?? '')}` };
    case 'list_games':
      return listGames(ctx.projectRoot);
    case 'memory_search':
      return searchMemory(memoryRef(ctx), String(args?.query ?? ''));
    case 'remember':
      return remember(ctx, args);
    case 'query_world':
      return perceptionQuery(ctx, 'world', args?.query);
    case 'capture_frame': {
      const snap = await perceptionQuery(ctx, 'frame');
      const dataUrl =
        snap && typeof snap === 'object' && typeof (snap as { dataUrl?: unknown }).dataUrl === 'string'
          ? (snap as { dataUrl: string }).dataUrl
          : '';
      if (!dataUrl) {
        const reason = snap && typeof snap === 'object' ? (snap as { reason?: unknown }).reason : undefined;
        return { unavailable: true, reason: reason ?? 'no frame' };
      }
      return { bytes: dataUrl.length, dataUrl: `${dataUrl.slice(0, 64)}…` };
    }
    default:
      // 防御:isForgeaxBuiltinTool 已挡;落到这里说明集合与 switch 失同步。
      return { error: `not a forgeax builtin tool: ${name}` };
  }
}
