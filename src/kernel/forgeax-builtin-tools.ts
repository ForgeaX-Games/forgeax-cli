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
import { randomUUID } from 'node:crypto';
import type { Event } from '../core/types';
import type { LayeredMemoryRef } from '../soul/types';
import { soulMemoryRoot, searchMemory, classifyAndWrite } from '../soul';
import { registerPerception } from '../api/lib/perception-registry';
import { uiInvokeTimeoutMs, getUiAction } from '../api/lib/ui-manifest-registry';
import { getHostUiAction, type HostToolRunCtx } from '../orchestration-seams';
import { getBuiltinHeadlessUiAction } from './ui-headless-actions';

/** 仅需 publish 的最小事件发布口(`EventBus` 类 / 绑定 bus / 测试桩皆满足)。 */
export interface EventPublisher {
  publish(event: Event, emitterId?: string): void;
}

/** 内置 forgeax 工具名集合(与 compose-turn-request 的 FORGEAX_TOOLS + .mjs TOOLS 对齐)。
 *  游戏语义工具(list_games/query_world/capture_frame)已迁产品壳经 HostToolSpec seam
 *  注入(P1-7),不再是编排层内置——执行口对 seam 工具走 `HostToolSpec.run`。 */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'echo',
  'memory_search',
  'remember',
  'ui_snapshot',
  'ui_invoke',
]);

/** 该工具是否为内置 forgeax 工具(宿主侧有实现,不查 agent kit 注册表)。 */
export function isForgeaxBuiltinTool(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/** 感知/UI 往返的 query kind(闭合 union:server 端点与本模块共守)。 */
export type PerceptionKind = 'world' | 'frame' | 'ui_snapshot' | 'ui_invoke';

/** 内置工具执行上下文(显式声明的输入,Pipeline Isolation)。 */
export interface BuiltinToolCtx {
  /** 工作区根(.forgeax/games · souls 解析基准)。 */
  projectRoot: string;
  /** soul 记忆库归属 agent(= 本轮 agentPath);决定 `.forgeax/souls/<agentId>/memory`。 */
  agentId: string;
  /** 本会话绑定 / 当前激活的游戏 slug。`remember kind:'game'` 与 episodes 召回按此隔离;
   *  缺省 = 通用上下文(game-bound 记忆将拒写)。 */
  game?: string;
  /** 感知接地工具(query_world/capture_frame/ui_*)的会话总线;缺省则降级为 unavailable。 */
  eventBus?: EventPublisher;
  /** 会话 id —— ui_* 往返的 lease 把关与 manifest 超时查表键;缺省时 ui_* 降级 unavailable。 */
  sid?: string;
}

const PERCEPTION_TIMEOUT_MS = 8_000;
/** ui_invoke 通道默认超时(略宽于取数:invoke 要等 action 执行/受理)。 */
const UI_INVOKE_TIMEOUT_MS = 10_000;

function memoryRef(ctx: BuiltinToolCtx): LayeredMemoryRef {
  return { root: soulMemoryRoot(ctx.projectRoot, ctx.agentId), ...(ctx.game ? { game: ctx.game } : {}) };
}

/** 把内置工具执行上下文适配成 seam 工具的 `HostToolRunCtx`(两个执行口对
 *  `HostToolSpec.run` 调用时用)。`perception` 绑定本会话总线 —— shell 注入的感知类
 *  工具(query_world/capture_frame)经它走编排层通用往返;UI 未连 fail-soft。 */
export function hostToolRunCtx(ctx: BuiltinToolCtx): HostToolRunCtx {
  return {
    ...(ctx.sid ? { sid: ctx.sid } : {}),
    agentId: ctx.agentId,
    projectRoot: ctx.projectRoot,
    ...(ctx.game ? { game: ctx.game } : {}),
    perception: (kind, query) => perceptionQuery(ctx, kind, query),
  };
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
 *  前端取真值(game iframe 或 ActionRegistry)后 POST /perception-reply 解开;超时
 *  fail-soft 返回 unavailable。镜像 `:sid/perception-query` 路由,在 forgeax-core
 *  in-process 路径里复用同一 registry。ui_* 类查询的回灌被 lease 把关(声明与执行方
 *  同源,见 ui-manifest-registry)。 */
async function perceptionQuery(
  ctx: BuiltinToolCtx,
  kind: PerceptionKind,
  query?: unknown,
  timeoutMs: number = PERCEPTION_TIMEOUT_MS,
): Promise<unknown> {
  if (!ctx.eventBus) return { unavailable: true, reason: 'no event bus' };
  const isUiKind = kind === 'ui_snapshot' || kind === 'ui_invoke';
  if (isUiKind && !ctx.sid) return { unavailable: true, reason: 'no session id for ui bridge' };
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
  const handle = registerPerception(reqId, timeoutMs, isUiKind && ctx.sid ? { requireLease: { sid: ctx.sid } } : {});
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
    case 'memory_search':
      return searchMemory(memoryRef(ctx), String(args?.query ?? ''));
    case 'remember':
      return remember(ctx, args);
    // UI 语义操作层(产品 AI 化 P0):与 seam 感知工具同构的往返,应答方是 interface
    // 的 ActionRegistry。契约(schema/description)SSOT = ui-bridge-contract.json。
    case 'ui_snapshot':
      return perceptionQuery(ctx, 'ui_snapshot', args ?? {});
    case 'ui_invoke': {
      // 超时按 manifest 里 action 声明的 timeoutMs 放宽(clamp [1s,30s]);慢 action 的
      // 正道是 UI 侧快速回 accepted(受理即答),不是拉长超时硬等——见契约 description。
      const actionId = typeof args?.actionId === 'string' ? args.actionId : '';
      const timeout = uiInvokeTimeoutMs(ctx.sid, actionId, UI_INVOKE_TIMEOUT_MS);
      const out = await perceptionQuery(ctx, 'ui_invoke', { actionId: actionId || null, args: args?.args ?? {} }, timeout);
      // P1-8 headless 回落(方案 §5):UI 不在线(unavailable)且该 action 声明了
      // surface 'server'|'both' → 走宿主侧等价 handler(seam 注入优先,cli 内置次之;
      // handler 必须调与 UI run() 相同的内部实现,server 是行为 SSOT)。声明 'ui' 或
      // 无 handler → 保持 unavailable 原样返回(模型据契约 description 自行跳过)。
      if (out && typeof out === 'object' && (out as { unavailable?: unknown }).unavailable === true && actionId) {
        const decl = getUiAction(ctx.sid, actionId);
        if (decl && (decl.surface === 'server' || decl.surface === 'both')) {
          const handler = getHostUiAction(actionId) ?? getBuiltinHeadlessUiAction(actionId);
          if (handler) {
            try {
              const res = await handler.run((args?.args ?? {}) as Record<string, unknown>, hostToolRunCtx(ctx));
              return res && typeof res === 'object' ? { ...res, executedVia: 'headless' } : res;
            } catch (e) {
              return { status: 'rejected', reason: `headless handler threw: ${(e as Error).message}` };
            }
          }
        }
      }
      return out;
    }
    default:
      // 防御:isForgeaxBuiltinTool 已挡;落到这里说明集合与 switch 失同步。
      return { error: `not a forgeax builtin tool: ${name}` };
  }
}
