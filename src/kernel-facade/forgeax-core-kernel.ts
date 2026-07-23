/**
 * ForgeaxCoreKernel (Wave4 FACADE, K10/K11) — implements the C6 `AgentKernel`
 * contract as a THIN shell over the native CoreAgent.
 *
 * 设计稿: 最终实现方案 §7 (facade 是薄壳：把 TurnRequest 翻成原生 Agent.run 的输入、
 * 把 AgentEvent 翻成 KernelEvent;原生 API 才是主面)。这是第三内核 'forgeax-core'
 * (contract.ts 的 drop-in 槽),消费 host-owned `TurnRequest.history` 作权威上下文。
 *
 * Boundary: 仅 import @forgeax/agent-runtime(契约) + core 相对。不引 cli/外部内核/SDK。
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  ModelRef,
  PermissionMode,
  TurnDoneReason,
  TurnHandle,
  TurnMessage,
  TurnRequest,
  ForkExtractRequest,
  ForkExtractResult,
} from '@forgeax/agent-runtime/contract';
import { CoreAgent, DEFAULT_MAIN_MAX_TURNS } from '../agent/agent';
import { EventBus } from '../events/event-bus';
import { CoreEventType } from '../events/events';
import { runForkedAgent } from '../agent/forked-agent';
import type { AgentContext, AgentEvent, TerminalReason } from '../agent/types';
import type { AgentTool } from '../capability/types';
import { buildTool } from '../capability/types';
import type { LLMProvider, ProviderMessage, ProviderRequest, ProviderStreamEvent } from '../provider/types';
import { makeProviderCompactSummarize } from '../context/compaction-llm';
import { makeRehydrateInjection } from '../context/post-compact-rehydrate';
import { microCompact } from '../context/micro-compaction';
import { contextWindowForModel } from '../context/model-window';
import { DEFAULT_SUBAGENT_MAX_TURNS, makeTaskTool, runSubagent } from '../agent/subagent';
import type { SubagentRegistry } from '../agent/subagent-registry';
import { handoffTool } from '../capability/builtin-tools/message-tools';
import type { PermissionMode as NativePermissionMode } from '../permission/engine';
import type { PermissionRuleSet } from '../permission/rules';
import type { AskUserFn } from '../agent/dispatch';
import type { ServerRequestDeps } from '../capability/mcp/server-requests';
import type { TokenProvider } from '../capability/mcp/auth';
import type { HandoffSink, AskQuestionFn } from '../inject/types';
import type { EventStore } from '../inject/types';
import { foldFromStore } from '../history/llm-fold-adapter';
import type { CoreEvent } from '../events/types';
import type { Observability } from '../observability/contract';
import { NOOP_OBS, parentContextFromTraceparent } from '../observability/contract';
import { cacheHitRate, promptTokens } from '../observability/usage';
import { readFileSync } from 'node:fs';
import { imageBlockFromAttachment as buildImageBlockFromAttachment, documentBlockFromAttachment } from '../capability/image-block';
import {
  needsDownscale,
  base64LengthOfRaw,
  IMAGE_MAX_B64_BYTES,
  type DownscaleImage,
} from '../capability/image-scale-policy';

/** 把 `TurnRequest.input.attachments` 里的图片项组成 Anthropic image content block。
 *  逻辑下沉到共享 helper(`capability/image-block.ts`),read_file(011)与此处共用。
 *  这里只注入「host 路径读盘」(serve 子进程同盘可同步读 → 大图走引用不撑爆 wire)。
 *  非图片 / 无数据的项静默跳过(forward-compat)。 */
function imageBlockFromAttachment(att: Record<string, unknown>): Record<string, unknown> | null {
  const block = buildImageBlockFromAttachment(att, (path) => readFileSync(path));
  return block as Record<string, unknown> | null;
}

/** 组 user 消息 payload:无附件 → 纯文本字符串(零回归);有附件 → content 数组
 *  [text, document/image…]。document(PDF)直接组块送 API,无缩放语义;
 *  ★ 图片进 context 前缩图(对齐 CC):超 2000×2000 / raw 3.75MB 经注入的 downscale 缩;
 *  缩不动且 base64 超 5MB → 换成占位文本块(loud degrade —— 原样送出必被 API 拒)。 */
async function buildUserPayload(
  text: string,
  attachments: TurnRequest['input']['attachments'],
  downscale?: DownscaleImage,
): Promise<string | Array<Record<string, unknown>>> {
  if (!attachments || attachments.length === 0) return text;
  const blocks: Array<Record<string, unknown>> = [];
  for (const att of attachments) {
    const doc = documentBlockFromAttachment(att, (path) => readFileSync(path));
    if (doc) {
      blocks.push(doc as unknown as Record<string, unknown>);
      continue;
    }
    const block = imageBlockFromAttachment(att);
    if (!block) continue;
    const source = block.source as { media_type: string; data: string };
    // Buffer 本身即 Uint8Array,直接用,免二次拷贝大附件(needsDownscale/downscale 收 Uint8Array)。
    const bytes = Buffer.from(source.data, 'base64');
    if (needsDownscale(bytes)) {
      const scaled = downscale ? await downscale(bytes, source.media_type) : null;
      if (scaled) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: scaled.mediaType,
            data: Buffer.from(scaled.bytes).toString('base64'),
          },
        });
        continue;
      }
      if (base64LengthOfRaw(bytes.length) > IMAGE_MAX_B64_BYTES) {
        blocks.push({
          type: 'text',
          text: `[image attachment dropped: ${bytes.length} bytes exceeds the 5MB API limit and no image downscaler is available]`,
        });
        continue;
      }
    }
    blocks.push(block);
  }
  if (blocks.length === 0) return text; // 附件都无法解析 → 退回纯文本
  return [{ type: 'text', text }, ...blocks];
}

/** 每轮 handoff 工厂的上下文 —— 让 host 用**本轮的** provider/model/工具建调度器,
 *  使被 spawn 的子 agent 拿到与父同源的 host 工具(经 executeTool 桥回主机)。 */
export interface TurnHandoffCtx {
  provider: LLMProvider;
  model: string;
  /** 本轮 host 工具(已 wrap;不含 Task/Handoff)——子 agent 的工具集应取此,防递归。 */
  tools: AgentTool[];
}

/** handoff 注入:可给定**固定** HandoffSink,或给一个**每轮工厂**(推荐:子 agent 需本轮工具)。
 *  返回 undefined = 本轮不启用 handoff(维持单 agent)。 */
export type HandoffProvider = HandoffSink | ((ctx: TurnHandoffCtx) => HandoffSink | undefined);

/** host-tool 执行缝(K11):facade 不自己执行工具,委托 host(对齐合订方案 §5 方案 A
 *  的 `POST /:sid/kernel-tool` 桥)。`agentId` = 本轮真实 agent(委派轮里即被委派方,
 *  如 mochi),供 host 桥按真实身份求 trustTier / 弹权限卡 / 选执行 context;缺省回落主 agent。 */
export type ExecuteToolFn = (name: string, args: unknown, sid?: string, agentId?: string, callId?: string) => Promise<unknown>;

export interface ForgeaxCoreKernelOptions {
  /** 注入 provider(per-session baseUrl+token 经 ConfigSource;支持 M4)。 */
  provider: LLMProvider;
  /** host-tool 执行桥。 */
  executeTool: ExecuteToolFn;
  /** 初始权限模式(engine 原生;缺省 'default')。`setPermissionMode` 运行中可改活 agent。 */
  initialMode?: NativePermissionMode;
  /** host 注入的权限规则集(deny/ask/allow);透传给每轮 CoreAgent,使 facade 驱动的轮也尊规则。 */
  rules?: Partial<PermissionRuleSet> | null;
  /** 交互式权限回路('ask' 判定时咨询 host);缺省 → 'ask' fail-closed deny。 */
  askUser?: AskUserFn;
  /**
   * 008 结构化提问接缝(AskUserQuestion 工具用)。区别于权限 `askUser`(yes/no):
   * 这里是**结构化多选问题**消歧(选方案 A/B、确认需求)。注入后 facade 把它挂到每轮
   * 的 `toolContext.askQuestion`,工具经 ctx 取用并把 questions 转给 host;host 决定
   * 怎么弹给用户 —— 复用现有 permission **card-pop** 的 EventBus→WS 信道(提问与审批
   * 同信道、不同 payload),由 serve→Studio 收集用户选择后 resolve。**缺省不注入 →
   * AskUserQuestion 调用时优雅降级(回灌 unsupported,不断流)**。
   */
  askQuestion?: AskQuestionFn;
  /** 额外注入的 toolContext(IO 能力)。本进程内本地工具(localToolImpls)经此取 sandboxFs/terminal。 */
  toolContext?: Record<string, unknown>;
  /** ★ 可观测性(trace+log)注入缝。serve.ts 经 `makeNodeObservability({send:rpcSend})` 造,
   *  透传给每轮 `new CoreAgent({...observability})` + 挂进 toolContext(工具侧 trace)。
   *  缺省 → CoreAgent 兜底 NOOP_OBS,零行为变化。见 observability/contract.ts。 */
  observability?: Observability;
  /**
   * 本地工具实现表(B 路径,host=serve 注入):name → core builtin `AgentTool`。
   * 当 `ToolSpec.delivery==='local'` 且这里有同名实现时,wrapTools 用它**在本进程内直跑**
   * (经 toolContext.sandboxFs),不回宿主;否则 fail-safe 落回 executeTool 桥(=host 路径)。
   * 缺省不注入 → 所有工具走 host 桥(现状 A,零行为变化)。kernel-facade 不 import cli/io,
   * 实现由 HOST 层(serve.ts)装配后注入(保边界:机制层不碰 node:fs)。
   */
  localToolImpls?: AgentTool[];
  /** thinking(扩展思考)配置;给了即对每轮请求开启,并吐 thinking.delta。 */
  thinking?: ProviderRequest['thinking'];
  /**
   * ★ CORE-CTX-005:超限 tool 结果被截断时把**全量** raw 落盘的钩子(host/sessionDir 领地)。
   * facade 无 session 目录概念,故作**注入接缝**:HOST 层(serve.ts/server)据自己的会话目录
   * 装配后注入;缺省不注入 → 截断即中段永久丢(旧行为)。返回可回读路径 → marker 追加
   * `; full result at <path>`。
   */
  persistToolResult?: (raw: string, meta: { toolUseId: string; toolName: string }) => string | undefined;
  /**
   * ★ 图片缩放注入缝(对齐 CC:附件图进 context 前钳到 2000×2000 / raw 3.75MB)。
   * facade 不碰系统二进制,实现由 HOST 层(serve.ts 用 cli/image-scale.ts 的
   * `makeImageDownscaler()`)装配后注入;缺省不注入 → 超 5MB 附件换占位文本(loud),
   * 5MB 内原样透传(旧行为)。
   */
  downscaleImage?: DownscaleImage;
  /**
   * MCP server→client 反向请求(elicitation/sampling/roots)的 host handler 集合(M4)。
   *
   * facade 自身**不装配 MCP client**(它只把 host 声明的工具经 `executeTool` 桥转发),
   * 故这里只是一个**存储接缝**:host 在 facade 外部用 core 的 `InProcessMCPClient` /
   * `resolveMcpClient` 接 MCP 时,可经 {@link ForgeaxCoreKernel.serverRequestDeps}
   * 取回本对象传给 `new InProcessMCPClient(server, transport, deps)`。core 不在内部
   * 调用它(避免凭空发明 MCP 装配流水线)。
   */
  serverRequestDeps?: ServerRequestDeps;
  /**
   * MCP 鉴权 token 提供方(M3)。同 {@link serverRequestDeps},仅作**存储接缝**:host
   * 在 facade 外装配 MCP client 时,可经 {@link ForgeaxCoreKernel.tokenProvider} 取回
   * 传给 `resolveMcpClient(..., { tokenProvider })` / `new FetchMCPClient(..., { tokenProvider })`。
   */
  tokenProvider?: TokenProvider;
  /**
   * ★ 多 agent 协作:handoff 调度接缝(forgeax-core 专属,**不在 AgentKernel 契约上**)。
   * 注入后,模型经 `Handoff` 工具发出的意图会在每轮 CoreAgent 的 handoff_decision 阶段
   * 经 `declare(intent)` 交给 host 调度器(如 agent-host 的 `InProcessScheduler`),据此
   * spawn 子 agent / 挂起 / 唤醒。**缺省不注入 → 维持单 agent(零行为变化)**。
   *
   * 说明:此能力仅在 'forgeax-core' 内核激活时可用;rented(外部)内核是
   * 子进程 CLI,不暴露此控制面,故 peer 多 agent 不跨内核——这是既定取舍(方案 A),
   * facade 把它作为**自身构造选项**而非契约特性,从不要求其它内核实现。
   *
   * 形态:可给固定 `HandoffSink`,或给**每轮工厂** `(ctx)=>HandoffSink`(推荐,见
   * {@link TurnHandoffCtx})。注入后,facade 会额外把内建 `Handoff` 工具加进模型工具集,
   * 使模型能发起意图;否则模型无从触发 handoff(即便注了 sink 也不会动)。
   */
  handoff?: HandoffProvider;
  /**
   * ★ P0 registry 接缝(additive):subagent 类型注册表。注入后,facade 把它连同
   * `allTools`(本轮 host 工具)传给 `makeTaskTool`,使子 agent 按 `subagent_type`
   * 做**按类型工具过滤 / system / model / maxTurns / budget** 解析(此时**不再**传
   * `resolveTools: () => hostTools`,让 registry 的 `allowedTools` 过滤器生效)。
   *
   * **缺省 ⇒ 维持现状 byte-for-byte**:沿用今日的 `resolveTools`/`resolveSystem`
   * 兜底(子拿全量 host 工具、固定 system 文案),零行为变化。
   */
  subagentRegistry?: SubagentRegistry;
  /**
   * ★ T6 子 agent 持久化/续聊接缝(additive):按 agentId 取子 loop transcript 的
   * `EventStore`。注入后:
   *   - 每次 Task 派子会生成**唯一 agentId** 并把子 transcript 落盘(经此工厂取的 store);
   *     该 agentId 经 `x.subagent.*` 事件 / tool.result 透给 host,作续聊句柄。
   *   - `resumeSubagent(agentId, prompt)` 用同一工厂取回该 agentId 的 store,fold 出历史
   *     → 续跑(带上一次上下文)。
   *   - **缺省 ⇒ 子 loop 仅内存、无对外可 resume 句柄(维持现状 byte-for-byte,零回归)**。
   * host(serve)按 agentId 派生磁盘路径造 `JsonlFileEventStore` 注入 —— facade 不碰 node:fs
   * (保 mechanism/facade 边界:store 是注入的 opaque 对象)。
   */
  subagentStore?: (agentId: string) => EventStore | undefined;
}

/** 契约中立 PermissionMode → engine 原生 PermissionMode(facade 翻译;spine 不说内核私有词汇)。
 *  gated→default · autoEdits→acceptEdits · planning→plan · unrestricted→bypassPermissions。
 *  越界值 → default(fail-safe,最严的标准把闸)。 */
export function translateNeutral(m: PermissionMode): NativePermissionMode {
  switch (m) {
    case 'gated':
      return 'default';
    case 'autoEdits':
      return 'acceptEdits';
    case 'planning':
      return 'plan';
    case 'unrestricted':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

const CAPS: KernelCapabilities = {
  streaming: true,
  // 底层 CoreAgent 支持扩展思考(provider 已通),facade 透传并吐 thinking.delta。
  thinking: true,
  toolCalls: true,
  // facade 走「轮间」语义(midTurnInject=false);原生 Agent API 经 steeringSource 支持回合中插话。
  midTurnInject: false,
  // forkExtract 已实现(本类 forkExtract() 经 runForkedAgent 复用缓存前缀做后台提取)。
  forkExtract: true,
};

/** terminal reason → 契约 TurnDoneReason。 */
function mapReason(r: TerminalReason): TurnDoneReason {
  switch (r) {
    case 'completed':
      return 'stop';
    case 'max_turns':
      return 'max_turns';
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'cancelled';
    case 'model_error':
    case 'unrecoverable_tool_error':
    case 'prompt_too_long':
    case 'blocking_limit':
      return 'error';
    // stop-hook 收尾:模型本欲停,被 hook 拦下后达上限而终止——非错误,作正常停。
    case 'stop_hook_prevented':
      return 'stop';
    default:
      return 'stop';
  }
}

/** TurnRequest.history(契约中立形) → ProviderMessage[]。 */
function mapHistory(history: TurnMessage[] | undefined): ProviderMessage[] {
  if (!history) return [];
  const out: ProviderMessage[] = [];
  for (const m of history) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content });
    else
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.result, is_error: !m.ok }],
      });
  }
  return out;
}

/** 从 assistant AgentEvent 抽文本(message.delta 用)。 */
function assistantText(message: { payload?: unknown }): string {
  const content = (message.payload as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** subagent 生命周期回调 payload(SubagentDeps.onSubagentEvent 的事件形)。 */
type SubEvent = {
  type: string;
  agentId: string;
  agentType?: string;
  role?: string;
  depth?: number;
  turn?: number;
  toolName?: string;
  toolUseId?: string;
  reason?: string;
  turns?: number;
  toolCalls?: number;
};

/**
 * L5:把 `onSubagentEvent` 回调事件映射成 `x.subagent.*` KernelEvent(出墙观测)。
 * 未知 type 返回 null(被丢弃)。字段对齐 SHARED CONTRACT。
 */
function subEventToKernel(ev: SubEvent): KernelEvent | null {
  switch (ev.type) {
    case 'subagent.start':
      return {
        kind: 'x.subagent.start',
        agentId: ev.agentId,
        agentType: ev.agentType,
        role: ev.role,
        depth: ev.depth ?? 0,
      };
    case 'subagent.turn':
      return { kind: 'x.subagent.turn', agentId: ev.agentId, turn: ev.turn ?? 0 };
    case 'subagent.tool_call':
      return { kind: 'x.subagent.tool', agentId: ev.agentId, callId: ev.toolUseId ?? '', name: ev.toolName ?? '' };
    case 'subagent.stop':
      return {
        kind: 'x.subagent.done',
        agentId: ev.agentId,
        reason: ev.reason ?? 'completed',
        turns: ev.turns ?? 0,
        toolCalls: ev.toolCalls ?? 0,
      };
    default:
      return null;
  }
}

/**
 * T5:内部 `CompactionApplied` bus 事件 → `compact_boundary` KernelEvent(出墙观测)。
 * 纯映射(loop 已在事件上带 preTokens/postTokens/trigger;老发布方缺这三字段时优雅降级为 undefined)。
 */
function compactionToKernel(payload: {
  coveredFrom: number;
  coveredTo: number;
  preTokens?: number;
  postTokens?: number;
  trigger?: string;
}): KernelEvent {
  return {
    kind: 'compact_boundary',
    coveredFrom: payload.coveredFrom,
    coveredTo: payload.coveredTo,
    ...(payload.trigger !== undefined ? { trigger: payload.trigger } : {}),
    ...(payload.preTokens !== undefined ? { preTokens: payload.preTokens } : {}),
    ...(payload.postTokens !== undefined ? { postTokens: payload.postTokens } : {}),
  };
}

/** T5:内部 `ApiRetry` bus 事件 → `api_retry` KernelEvent(出墙观测)。纯映射。 */
function apiRetryToKernel(payload: { attempt: number; reason: string; retryAfterMs?: number }): KernelEvent {
  return {
    kind: 'api_retry',
    attempt: payload.attempt,
    reason: payload.reason,
    ...(payload.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
  };
}

export class ForgeaxCoreKernel implements AgentKernel {
  readonly id = 'forgeax-core' as const;
  readonly capabilities = CAPS;
  private readonly o: ForgeaxCoreKernelOptions;
  private readonly handles = new Map<string, CoreAgent>();
  /** 当前权限模式(engine 原生)。新轮 CoreAgent 以此构造;`setPermissionMode` 经
   *  translateNeutral 改活 agent 并存这里,使无 live handle 时新轮也带上新模式。 */
  private currentMode: NativePermissionMode;
  /** 进入 plan 前的权限模式(仅 currentMode==='plan' 期间有意义)。每轮带给 CoreAgent,
   *  ExitPlanMode 获批退出时恢复它;轮终从 agent 回读(applyMode/syncModeFromAgent 维护)。 */
  private prePlanMode: NativePermissionMode | undefined;
  /** 当前模型(控制面 `setModel` 覆盖)。设了即**取代** req.model 作为新轮 + 活 agent 的
   *  权威模型源(与 currentMode 同语义:控制面 override 持久,直到再次 setModel)。 */
  private currentModel: string | undefined;

  /**
   * ★ T6 resume 上下文(agentId → 派子时的 model/tools/toolContext)。子 loop 的历史由
   * `subagentStore` 持久化,但「用什么工具/模型续跑」是运行期配置 —— 派子时在此登记,
   * `resumeSubagent` 取回复用(缺失时降级到默认模型 + 空工具:历史仍可续,§9 优雅降级)。
   */
  private readonly resumeCtx = new Map<
    string,
    { model: string; tools: AgentTool[]; toolContext: Record<string, unknown> }
  >();

  /**
   * MCP server→client 反向请求 handler(M4 存储接缝;facade 不自调用)。host 在外部
   * 装配 MCP client 时取回传给 `InProcessMCPClient(server, transport, deps)`。
   */
  get serverRequestDeps(): ServerRequestDeps | undefined {
    return this.o.serverRequestDeps;
  }

  /**
   * MCP 鉴权 token 提供方(M3 存储接缝;facade 不自调用)。host 在外部装配 MCP client
   * 时取回传给 `resolveMcpClient(..., { tokenProvider })`。
   */
  get tokenProvider(): TokenProvider | undefined {
    return this.o.tokenProvider;
  }

  constructor(opts: ForgeaxCoreKernelOptions) {
    this.o = opts;
    this.currentMode = opts.initialMode ?? 'default';
  }

  /** 切换 kernel 级权限模式,同步维护 prePlanMode(进 plan 记录进入前模式、离开清掉)。
   *  控制面 setPermissionMode 与 TurnRequest.permissionMode 两条入口共用(SSOT)。 */
  private applyMode(native: NativePermissionMode): void {
    if (native === 'plan' && this.currentMode !== 'plan') this.prePlanMode = this.currentMode;
    else if (native !== 'plan') this.prePlanMode = undefined;
    this.currentMode = native;
  }

  /** 轮终从 agent 回读模式状态。修复既有失同步:agent 内 ExitPlanMode 恢复模式后,
   *  facade 若不回读,下一轮仍按旧模式(plan)构造新 agent,退出形同虚设。 */
  private syncModeFromAgent(agent: CoreAgent): void {
    this.currentMode = agent.getMode();
    this.prePlanMode = agent.getPrePlanMode();
  }

  /**
   * 应用 `TurnRequest.toolPolicy`(契约 contract.ts:184)到最终模型工具集。
   *
   * 为何在此:host 声明的 `req.tools` 是宿主可控的白名单,但 facade 会在其上**额外叠加**
   * 内核内建编排工具(`Task` 子 agent / `Handoff` 团队交接;plan 下的 `ExitPlanMode` 由
   * CoreAgent loop 逐轮补注,不经此裁剪——它是模型走出 plan 的唯一缝,裁掉会把 plan 变死锁)。
   * 这些内建工具不在 host roster 里,若无条件注入,game-gen 等 profile 会**意外暴露**编排能力
   * (模型可能派子 agent、改变生成路径/产物归属,见验收报告 D.3)。`toolPolicy` 让宿主按
   * profile roster 精确裁剪:studio 侧对不打算开放编排的 profile 传 `deny:['Task','Handoff']`
   * 即与 legacy(无内建包)对齐。
   *
   * 语义(对齐契约注释):
   *   - `allow` 存在 → **独占白名单**,只保留名字命中的工具(缺省 ⇒ 全放行)。
   *   - `deny`  → 从模型上下文移除;支持裸名(`Bash`)与通配(`mcp__*`)。
   *   - 缺省(policy 全空)⇒ 全放行(向后兼容,零行为变化)。
   */
  private applyToolPolicy(tools: AgentTool[], policy: TurnRequest['toolPolicy']): AgentTool[] {
    if (!policy || (!policy.allow?.length && !policy.deny?.length)) return tools;
    const toMatcher = (pat: string): ((name: string) => boolean) =>
      pat.endsWith('*') ? (name) => name.startsWith(pat.slice(0, -1)) : (name) => name === pat;
    const allow = policy.allow?.length ? policy.allow.map(toMatcher) : null;
    const deny = policy.deny?.length ? policy.deny.map(toMatcher) : null;
    return tools.filter((t) => {
      if (allow && !allow.some((m) => m(t.name))) return false;
      if (deny && deny.some((m) => m(t.name))) return false;
      return true;
    });
  }

  /** ToolSpec → AgentTool,call 委托 host-tool 桥(K11)。 */
  private wrapTools(req: TurnRequest): AgentTool[] {
    const sid = req.hostSessionId as string | undefined;
    // 本轮真实 agent —— 透给 host 桥(委派轮里即被委派方,如 mochi);丢了会让权限卡错记到主 agent。
    const agentId = req.session?.agentId;
    // 本地实现表(B 路径):name → core builtin AgentTool(host=serve 注入)。
    const localByName = new Map((this.o.localToolImpls ?? []).map((t) => [t.name, t]));
    return req.tools.map((spec) => {
      // delivery==='local' 且有同名本地实现 → 本进程内直跑(经 ctx.sandboxFs,不回宿主)。
      //   拿不到本地实现 → fail-safe 落回下方 host 桥(永不因缺实现而失能)。
      if (spec.delivery === 'local') {
        const impl = localByName.get(spec.name);
        if (impl) return impl;
      }
      // 'host'/缺省 → executeTool 桥回宿主(现状 A;host 复跑 checkKernelTool 把闸)。
      return buildTool({
        name: spec.name,
        // host 在 ToolSpec.description 给了模型可读描述(compose-turn-request),
        // 必须透传到 AgentTool,否则 wire tools[] 没 description,模型只能靠名字猜。
        ...(spec.description ? { description: spec.description } : {}),
        inputJSONSchema: spec.inputSchema ?? {},
        // ctx.toolUseId = 本轮工具调用 id(= tool.call/tool.result 的 callId)。透传给 host
        // 桥,让宿主(studio remoteAgentRuntime)能把前端 HITL 卡片的 pending 表 key 钉在
        // 同一 id 上——否则 host 侧只能随机造 id,前端回填对不上 → ask_user_question 卡死。
        call: async (input: unknown, ctx) => ({ data: await this.o.executeTool(spec.name, input, sid, agentId, ctx?.toolUseId) }),
        mapResult: (data, id) => ({ type: 'tool.result', payload: { callId: id, ok: true, result: data }, ts: 0 }),
        maxResultSizeChars: Infinity,
      });
    });
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // ★ v3/B 档 可观测性:本轮 ROOT span(parent 默认 none —— turn 是一棵新树的根,正确)。
    //   sid/agentId 在入口即在作用域 → 直接盖 attribute(不走 baggage/onStart 桥,A.2-N3)。
    //   缺省 obs=NOOP_OBS → noop tracer 不出 span、noop logger 不出 log,零行为变化(§9 降级)。
    const obs = this.o.observability ?? NOOP_OBS;
    const sid = (req.hostSessionId as string | undefined) ?? req.session?.agentId ?? 'unknown';
    const turnAgentId = req.session?.agentId ?? 'unknown';
    // 全链路:若 host/浏览器经 `req.traceparent` 传来上游 span,kernel.turn 挂成它的 child
    //   (显式 parent,不读 active-context);缺省 undefined → 自建 root(零行为变化)。
    const parentCtx = parentContextFromTraceparent(req.traceparent);
    const turnSpan = obs.tracer.startSpan('kernel.turn', { attributes: { sid, agentId: turnAgentId } }, parentCtx);
    const turnSpanCtx = turnSpan.spanContext();
    // span-bound child logger:其后每条 record 天生带 traceId/spanId/sid/agentId(child bindings),
    //   reporter 不调 getActiveSpan()(W1)。下传给 toolContext.observability 供工具自 trace。
    const turnLogger = obs.logger.child({
      traceId: turnSpanCtx.traceId,
      spanId: turnSpanCtx.spanId,
      sid,
      agentId: turnAgentId,
    });
    turnLogger.info('kernel.turn start', { model: this.currentModel ?? req.model });
    let turnStatus: 'ok' | 'error' = 'ok';
    // 诊断维度(hoist 到外层 finally 可见):token 用量累计 + 本轮结束原因。
    const usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
    // 本次 provider 调用已经以 message.delta 流出的 assistant 文本(translate 的去重账,
    // 见 translate 内 'assistant' 分支;每次 provider_call 开始清零)。
    const streamed = { text: '' };
    let lastReason: ReturnType<typeof mapReason> | undefined;
    try {
    // system: charter+persona 作稳定缓存前缀(static slots);dynamicSuffix 进 user 末尾,
    // 绝不进 system(保前缀 cache 稳定,对齐 §7 / ComposedPrompt 注释)。
    const sp = req.systemPrompt;
    // 控制面 setModel 覆盖优先(持久),否则本轮 req.model,再否则默认。
    const model = this.currentModel ?? req.model ?? 'claude-opus-4-8';
    // P0:TurnRequest.permissionMode → 本轮起始模式(免一次 setPermissionMode 往返)。
    //   控制面 setPermissionMode 仍可中途再改;此处把 req 的初始模式落到 currentMode
    //   (applyMode 顺带维护 prePlanMode)。
    if (req.permissionMode) this.applyMode(translateNeutral(req.permissionMode));
    const hostTools = this.wrapTools(req);
    // ★ L5 observability:本轮 FIFO 队列,缓冲子 agent 生命周期回调投射出的 KernelEvent。
    //   onSubagentEvent 在 Task 工具 await 期间(即 agent.run 两次 yield 之间)同步推入,
    //   逐轮 drain 即可保 start→turn→tool→done 顺序排在父 tool.result 之前。
    //   ★ T5:同一队列也承载 compact_boundary / api_retry —— 它们经内部 bus 订阅在 agent.run
    //   执行(两次 yield 之间)同步推入,与子事件走同一逐轮 drain,顺序天然对齐本轮进度。
    const subQueue: KernelEvent[] = [];
    // ★ T5:本轮内部事件 bus —— 传给 CoreAgent(替代其自建 bus),订阅两个观测事件后转成
    //   KernelEvent 推进 subQueue。loop 其余事件对这两个订阅者是 no-op(按 type 过滤),零开销。
    const turnBus = new EventBus();
    const unsubCompact = turnBus.subscribe(CoreEventType.CompactionApplied, (e) => {
      subQueue.push(compactionToKernel(e.payload as Parameters<typeof compactionToKernel>[0]));
    });
    const unsubRetry = turnBus.subscribe(CoreEventType.ApiRetry, (e) => {
      subQueue.push(apiRetryToKernel(e.payload as Parameters<typeof apiRetryToKernel>[0]));
    });
    // ★ subagent:facade 注入原生 Task,使 forgeax-core 作内环驱动聊天时也能派子 agent。
    //   子 agent 跑在 forgeax-core 内(隔离上下文,自压缩),子工具 = host 工具(经同一桥),
    //   **不含 Task**(防递归):Task 是内核内建子 agent 工具,非 host 声明。
    //   ★ P0 registry 接缝:注入 subagentRegistry 时改走 registry + allTools(按类型过滤工具);
    //   缺省维持今日的 resolveTools/resolveSystem 兜底(零行为变化)。见 buildTaskTool。
    // 008:把 host 的 askQuestion 接缝挂到每轮 toolContext(AskUserQuestion 工具经 ctx 取用);
    //   缺省不挂 → 工具优雅降级。父/子 agent 共用同一 toolContext(子继承提问能力)。
    const toolContext: Record<string, unknown> = {
      ...(this.o.toolContext ?? {}),
      ...(this.o.askQuestion ? { askQuestion: this.o.askQuestion } : {}),
      // ★ v3/B 档:工具自 trace 用的能力束 —— tracer 原样,logger 用本轮 span-bound child,
      //   工具经此建子 span(显式认 parent)/出带 traceId 的 log,不押 active-context。
      observability: { tracer: obs.tracer, logger: turnLogger } satisfies Observability,
    };
    // taskTool 构造抽成 buildTaskTool(SSOT):forkExtract 复用同一份 → 工具定义字节一致,缓存键匹配。
    const taskTool = this.buildTaskTool(req, model, hostTools, toolContext, (k) => subQueue.push(k));
    // ★ peer 多 agent:每轮解析 handoff sink(工厂拿本轮 provider/model/host 工具,
    //   使被 spawn 的子 agent 用同源 host 工具)。注入了 sink 才把 Handoff 工具加进模型
    //   工具集 —— 否则模型无从触发,即便注了 sink 也维持单 agent(零行为变化)。
    const handoffSink =
      typeof this.o.handoff === 'function'
        ? this.o.handoff({ provider: this.o.provider, model, tools: hostTools })
        : this.o.handoff;
    // plan 出口工具(ExitPlanMode)不在此注入:CoreAgent loop 是唯一注入点(007,SSOT)——
    //   plan 模式的轮由 loop 逐轮补注,facade 与直连路径同源。
    // 内建编排工具(Task/Handoff)默认叠加;再经 req.toolPolicy 按 host roster 裁剪
    //   (缺省全放行 = 零行为变化;studio 对 game-gen profile deny Task/Handoff → 与 legacy 对齐,
    //   见 applyToolPolicy 与验收报告 D.3)。
    const assembled = handoffSink
      ? [...hostTools, taskTool, handoffTool()]
      : [...hostTools, taskTool];
    const tools = this.applyToolPolicy(assembled, req.toolPolicy);
    const context: AgentContext = {
      agentId: req.session.agentId,
      provider: this.o.provider,
      config: {
        systemPromptSlots: [
          { name: 'charter', render: () => sp.charter, cacheScope: 'global' },
          { name: 'persona', render: () => sp.persona, cacheScope: 'global' },
        ],
        model,
        tools,
        maxTurns: req.budget.maxTurns ?? DEFAULT_MAIN_MAX_TURNS,
      },
      toolContext,
    };

    const agent = new CoreAgent({
      context,
      globalCacheEnabled: true,
      // ★ T5:注入本轮 bus,使内部 CompactionApplied / ApiRetry 事件被 facade 订阅并出墙。
      bus: turnBus,
      // ★ WS-C:把权限模式 / 规则 / askUser 透传给每轮 CoreAgent,使 facade 驱动的轮也
      //   honor 注入规则、并让 setPermissionMode 改活 agent 真生效(dispatch 读 currentMode)。
      mode: this.currentMode,
      // 007:进入 plan 前的模式随轮带入,ExitPlanMode 获批退出时恢复它(轮终 syncModeFromAgent 回读)。
      ...(this.prePlanMode !== undefined ? { prePlanMode: this.prePlanMode } : {}),
      ...(this.o.rules !== undefined ? { rules: this.o.rules } : {}),
      ...(this.o.askUser ? { askUser: this.o.askUser } : {}),
      // F6 生产路径也开压缩(auto + micro);长会话不至于撑爆上下文。
      // ★ ISSUE-1:主轮自压缩走 Compaction V2(替换 legacy makeProviderCompaction)。
      //   D-01:压后重挂最近读文件(recentReadPaths 由 loop 自取内部 read-tracker)。
      compactionV2: {
        summarize: makeProviderCompactSummarize(this.o.provider, context.config.model),
        rehydrate: makeRehydrateInjection(context.toolContext),
      },
      microCompact: (msgs) => microCompact(msgs, { now: Date.now() }),
      // CORE-CTX-005:大结果落盘钩子(HOST 层经 options 注入;缺省不落盘=旧行为)。
      ...(this.o.persistToolResult ? { persistToolResult: this.o.persistToolResult } : {}),
      contextWindow: contextWindowForModel(context.config.model),
      ...(this.o.thinking ? { thinking: this.o.thinking } : {}),
      // ★ peer 多 agent:解析出 sink 才接;缺省 → handoff_decision 维持 no-op(单 agent)。
      ...(handoffSink ? { handoff: handoffSink } : {}),
      // ★ v3/B 档:把可观测性束 + 本轮 root span 显式下传 —— CoreAgent.run() 把 agent.run span
      //   建成 turnSpan 的 explicit child(并发多轮父子树不串,B2)。缺省 NOOP_OBS → 不出 span。
      observability: obs,
      parentSpan: turnSpan,
    });
    if (req.callId) this.handles.set(req.callId, agent);

    const userText = sp.dynamicSuffix ? `${req.input.text}\n\n${sp.dynamicSuffix}` : req.input.text;
    // 多模态:有图片附件时,user 消息 payload 升级为 content 数组([text, image…]),
    //   否则保持纯字符串(零回归)。content 数组经 agent.run(:567 content=payload)
    //   原样落到 provider(anthropic.ts:62 透传)→ 模型收到图。
    const userPayload = await buildUserPayload(userText, req.input.attachments, this.o.downscaleImage);
    let usageEmitted = false;

    const emitUsage = (): KernelEvent => ({
      kind: 'turn.usage',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheCreation,
    });

    try {
      for await (const ev of agent.run({
        input: { type: 'user', payload: userPayload, ts: 0 },
        history: mapHistory(req.history),
        signal,
      })) {
        const k = this.translate(ev, usage, streamed);
        if (k) yield k;
        // ★ L5:逐轮 drain 子 agent 事件队列。子事件在父 Task 工具 await 期间同步推入
        //   (即两次 agent.run yield 之间),逐轮 drain 保 start→turn→tool→done 顺序排在
        //   父 tool.result 之前。
        while (subQueue.length) {
          const s = subQueue.shift();
          if (s) yield s;
        }
        if (ev.type === 'done') {
          // 收尾前再 drain 一次,确保 done 阶段才推入的子事件不被漏掉。
          while (subQueue.length) {
            const s = subQueue.shift();
            if (s) yield s;
          }
          // B5 不变量:turn.usage 必在 turn.done 之前。
          yield emitUsage();
          usageEmitted = true;
          lastReason = mapReason(ev.terminal.reason);
          yield { kind: 'turn.done', reason: lastReason };
        }
      }
      // ★ L5:loop 结束后兜底 drain,防最后一批子事件随循环退出被丢弃。
      while (subQueue.length) {
        const s = subQueue.shift();
        if (s) yield s;
      }
    } finally {
      // 007:轮终回读 agent 模式(ExitPlanMode 可能已在轮内恢复模式;不回读则下一轮
      //   仍按 plan 构造新 agent,退出形同虚设——既有失同步 bug,顺带修复)。
      this.syncModeFromAgent(agent);
      if (req.callId) this.handles.delete(req.callId);
      // ★ T5:解订阅本轮 bus 观测事件(本轮结束即释放,不跨轮泄漏)。
      unsubCompact();
      unsubRetry();
    }
    // 防御:run 未吐 done(异常路径)也保证 usage-before 缺失不发生。
    if (!usageEmitted) {
      yield emitUsage();
      lastReason = signal.aborted ? 'cancelled' : 'error';
      yield { kind: 'turn.done', reason: lastReason };
    }
    } catch (e) {
      // ★ v3/B 档:本轮任意未捕获异常 → 标 turnSpan error 并上抛(finally 收尾 span)。
      turnStatus = 'error';
      const msg = e instanceof Error ? e.message : String(e);
      try { turnSpan.recordException(e instanceof Error ? e : new Error(msg)); } catch { /* noop tracer 可能无此 API */ }
      turnLogger.error('kernel.turn error', { error: msg });
      throw e;
    } finally {
      // SpanStatusCode: 1=OK / 2=ERROR(字面量,避免 import SDK 常量;仅 @opentelemetry/api 的 trace)。
      turnSpan.setStatus({ code: turnStatus === 'ok' ? 1 : 2 });
      // ★ 诊断维度:把「烧了多少 token / 为何结束 / 用哪个模型」盖到 span + done log,
      //   排查时无需翻多条事件,从这一行即读出本轮全貌。setAttribute 在 noop tracer 下可能无 → 容错。
      const doneModel = this.currentModel ?? req.model ?? 'unknown';
      // 缓存命中率/提示词总量(派生指标,直接落 trace 免下游再算;口径见 observability/usage)。
      const prompt = promptTokens(usage);
      const hitRate = cacheHitRate(usage);
      try {
        turnSpan.setAttribute('usage.input', usage.inputTokens);
        turnSpan.setAttribute('usage.output', usage.outputTokens);
        turnSpan.setAttribute('usage.cacheRead', usage.cacheRead);
        turnSpan.setAttribute('usage.cacheCreation', usage.cacheCreation);
        turnSpan.setAttribute('usage.promptTokens', prompt);
        turnSpan.setAttribute('usage.cacheHitRate', hitRate);
        turnSpan.setAttribute('model', doneModel);
        if (lastReason) turnSpan.setAttribute('reason', lastReason);
      } catch { /* noop tracer 无 setAttribute */ }
      turnLogger.info('kernel.turn done', {
        status: turnStatus,
        reason: lastReason ?? 'unknown',
        model: doneModel,
        usage: { ...usage, promptTokens: prompt, cacheHitRate: hitRate },
      });
      turnSpan.end();
    }
  }

  /** 原生 Task 工具构造(SSOT):runTurn 与 forkExtract 共用 → 工具定义字节一致,保 fork 缓存键匹配。 */
  private buildTaskTool(
    req: TurnRequest,
    model: string,
    hostTools: AgentTool[],
    toolContext: Record<string, unknown>,
    pushSub: (k: KernelEvent) => void,
  ): AgentTool {
    const registry = this.o.subagentRegistry;
    // ★ T6:注入了 subagentStore ⇒ 包一层,在派子(工厂被调)时按 agentId 登记 resume 上下文
    //   (本轮 model/hostTools/toolContext),供 resumeSubagent 续跑复用;再返回真实 store。
    //   缺省 undefined ⇒ makeTaskTool 不启用持久化,零回归。
    const subStore: ((agentId: string) => EventStore | undefined) | undefined = this.o.subagentStore
      ? (agentId: string) => {
          this.resumeCtx.set(agentId, { model, tools: hostTools, toolContext });
          return this.o.subagentStore!(agentId);
        }
      : undefined;
    return makeTaskTool({
      provider: this.o.provider,
      model,
      ...(registry
        ? { registry, allTools: hostTools }
        : {
            resolveTools: () => hostTools,
            resolveSystem: (t) => `You are a ${t ?? 'general'} subagent. Do the task and report the result concisely.`,
          }),
      toolContext,
      ...(subStore ? { subagentStore: subStore } : {}),
      // subagent 自压缩(V2)+ 压后重挂(D-01)。
      compactionV2: { summarize: makeProviderCompactSummarize(this.o.provider, model), rehydrate: makeRehydrateInjection(toolContext) },
      contextWindow: contextWindowForModel(model),
      maxTurns: req.budget.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      onSubagentEvent: (ev) => {
        const k = subEventToKernel(ev);
        if (k) pushSub(k);
      },
    });
  }

  /**
   * cache-safe fork 提取(契约 forkExtract):复用上一轮的 charter/persona + tools + history
   * (缓存键匹配 → 整段走 cache-read),尾部追加一条提取指令,工具执行门控到 `allowedTools`
   * (记忆写工具),后台跑、不污染主对话。返回工具调用次数 + 写过的文件路径。
   *
   * tools 复用 wrapTools(req) + buildTaskTool(与 runTurn 同一份 → 字节一致);常见编排场景(无
   * handoff/plan)即与上一轮 runTurn 的工具集逐字匹配,messages 命中缓存。
   */
  async forkExtract(req: ForkExtractRequest, signal: AbortSignal): Promise<ForkExtractResult> {
    const model = this.currentModel ?? req.model ?? 'claude-opus-4-8';
    const sp = req.systemPrompt;
    // 把 ForkExtractRequest 适配成 wrapTools 需要的 TurnRequest 形(只用到 tools/hostSessionId/session)。
    const wrapReq = {
      tools: req.tools,
      hostSessionId: req.hostSessionId,
      session: req.session,
      budget: {},
    } as unknown as TurnRequest;
    const hostTools = this.wrapTools(wrapReq);
    const toolContext: Record<string, unknown> = { ...(this.o.toolContext ?? {}) };
    const taskTool = this.buildTaskTool(wrapReq, model, hostTools, toolContext, () => {});
    const tools = [...hostTools, taskTool];
    const allowed = new Set(req.allowedTools);
    const result = await runForkedAgent(
      {
        parentMessages: mapHistory(req.history),
        systemPromptSlots: [
          { name: 'charter', render: () => sp.charter, cacheScope: 'global' },
          { name: 'persona', render: () => sp.persona, cacheScope: 'global' },
        ],
        model,
        tools,
        instruction: req.instruction,
        canUseTool: (name) => allowed.has(name),
      },
      { provider: this.o.provider, toolContext, signal },
    );
    return { ok: result.terminalReason === 'completed', toolCalls: result.toolCalls, writtenPaths: result.writtenPaths };
  }

  /**
   * ★ T6 有状态子 agent 续聊(契约 resumeSubagent)。按 `agentId` 取回该子 loop 之前落盘的
   * transcript(经 `subagentStore`),`foldFromStore` fold 成历史 → 作 initialMessages seed,
   * 用 `prompt` 续跑同一子 agent。续跑事件仍落回同一 store(append-only:一次 resume =
   * 往事件流尾部 APPEND 一轮,不是恢复快照 → store 始终是唯一真相 SSOT)。
   *
   * 续跑用什么工具/模型:优先取派子时登记的 resumeCtx(model/tools/toolContext);缺失
   * (如 sidecar 重启后 in-memory ctx 丢)→ 降级到 currentModel + 空工具集,历史仍可续
   * (§9 优雅降级)。
   *
   * 流出:子生命周期 `x.subagent.*`(start→turn→tool→done)+ 最终结果作 `message.delta`
   * + `turn.usage`/`turn.done`。找不到 store / 无历史 → 单条 `error` + `turn.done{error}`。
   */
  async *resumeSubagent(agentId: string, prompt: string, signal: AbortSignal): AsyncIterable<KernelEvent> {
    const store = this.o.subagentStore?.(agentId);
    if (!store) {
      yield {
        kind: 'error',
        error: { code: 'kernel_unavailable', message: `subagent persistence not configured; cannot resume ${agentId}` },
      };
      yield { kind: 'turn.done', reason: 'error' };
      return;
    }
    // fold 出历史(read 是可选能力;无 read / 空流 → 无历史)。
    const events: CoreEvent[] = [];
    if (store.read) {
      for await (const e of store.read()) events.push(e);
    }
    const initialMessages = foldFromStore(events);
    if (initialMessages.length === 0) {
      yield {
        kind: 'error',
        error: { code: 'kernel_unavailable', message: `no persisted history for subagent ${agentId}` },
      };
      yield { kind: 'turn.done', reason: 'error' };
      return;
    }

    const ctx = this.resumeCtx.get(agentId);
    const model = ctx?.model ?? this.currentModel ?? 'claude-opus-4-8';
    const tools = ctx?.tools ?? [];
    const toolContext = ctx?.toolContext ?? { ...(this.o.toolContext ?? {}) };

    // 子生命周期回调 → x.subagent.* 事件缓冲(runSubagent await 期间同步推入,await 后一次性 drain)。
    const subQueue: KernelEvent[] = [];
    const result = await runSubagent(
      {
        input: prompt,
        agentId,
        leadingSystemText:
          'You are a subagent resuming a prior task. Use your earlier context and continue; report the result concisely.',
        model,
        tools,
        initialMessages,
        eventStore: store,
        // 子自压缩(V2)+ 压后重挂(与 runTurn 一致)。
        compactionV2: {
          summarize: makeProviderCompactSummarize(this.o.provider, model),
          rehydrate: makeRehydrateInjection(toolContext),
        },
        contextWindow: contextWindowForModel(model),
      },
      {
        provider: this.o.provider,
        toolContext,
        ...(this.o.rules !== undefined ? { rules: this.o.rules } : {}),
        mode: this.currentMode,
        ...(this.o.askUser ? { askUser: this.o.askUser } : {}),
        signal,
        onSubagentEvent: (ev) => {
          const k = subEventToKernel(ev);
          if (k) subQueue.push(k);
        },
      },
    );

    // 先出子生命周期事件(start→…→done),再出最终结果文本,最后 usage/done。
    for (const k of subQueue) yield k;
    if (result.text) yield { kind: 'message.delta', role: 'assistant', text: result.text };
    yield { kind: 'turn.usage', inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
    yield { kind: 'turn.done', reason: mapReason(result.terminalReason) };
  }

  /** AgentEvent → KernelEvent(累计 usage / streamed 副作用)。返回 null = 不映射(内部阶段事件)。
   *  流式文本:text_delta 逐条映射成 message.delta(浏览器 UI 打字机的数据源),`streamed`
   *  记录本次 provider 调用已流出的文本;聚合 'assistant' 到达时只补「未流出的余量」——
   *  provider 不吐 text_delta(如测试 stub / 非流式后端)则余量 = 全文,优雅降级为旧行为。 */
  private translate(
    ev: AgentEvent,
    usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number },
    streamed: { text: string },
  ): KernelEvent | null {
    switch (ev.type) {
      case 'stage':
        // PTL / 窗口溢出重试同一 turn 时会重发 provider_call → 清零,保证 streamed
        // 精确等于「当前这一次模型调用」已流出的增量(重试前的残量不污染去重账)。
        if (ev.stage === 'provider_call') streamed.text = '';
        return null;
      case 'assistant': {
        const text = assistantText(ev.message);
        const already = streamed.text;
        streamed.text = '';
        if (!text) return null;
        if (already) {
          if (text === already) return null;
          // 增量与聚合按同一 delta 流构造,聚合只可能多不可能改 → 前缀关系;补发余量。
          if (text.startsWith(already)) return { kind: 'message.delta', role: 'assistant', text: text.slice(already.length) };
          // 结构上不应发生的不一致:已流出的为准,不重发全文(避免 UI 双份文本)。
          return null;
        }
        return { kind: 'message.delta', role: 'assistant', text };
      }
      case 'tool_call':
        return { kind: 'tool.call', callId: ev.toolUseId, name: ev.toolName, args: ev.input };
      case 'tool_result': {
        const p = ev.result.payload as { ok?: boolean; result?: unknown; isError?: boolean; message?: string };
        const ok = p.ok ?? !p.isError;
        // 非 ok 时带上 dispatch 写入的人类可读拒因/错误(errorEvent.message,含 plan 只读拒因)。
        return { kind: 'tool.result', callId: ev.toolUseId, ok, result: p.result, ...(ok ? {} : { error: p.message }) };
      }

      case 'stream': {
        const se = ev.event as ProviderStreamEvent;
        if (se.type === 'message_delta' && se.usage) {
          usage.outputTokens = se.usage.outputTokens ?? usage.outputTokens;
          usage.inputTokens = se.usage.inputTokens ?? usage.inputTokens;
          usage.cacheRead = se.usage.cacheReadInputTokens ?? usage.cacheRead;
          usage.cacheCreation = se.usage.cacheCreationInputTokens ?? usage.cacheCreation;
        }
        if (se.type === 'content_block_delta') {
          const d = se.delta as { type?: string; thinking?: string; text?: string } | undefined;
          // 扩展思考增量 → thinking.delta(契约事件)。
          if (d && (d.type === 'thinking_delta' || typeof d.thinking === 'string') && d.thinking) {
            return { kind: 'thinking.delta', text: d.thinking };
          }
          // 正文增量 → message.delta(逐 token 流出;'assistant' 分支据 streamed 去重)。
          if (d && d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
            streamed.text += d.text;
            return { kind: 'message.delta', role: 'assistant', text: d.text };
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  openHandle(callId: string): TurnHandle {
    const agent = this.handles.get(callId);
    const setMode = (mode: PermissionMode): void => {
      const native = translateNeutral(mode);
      // 存到 kernel(applyMode 顺带维护 prePlanMode;让无 live handle / 下一轮新 agent 也带上),
      // 并改活当前 agent(本轮即生效;agent.setMode 同步维护自己的 prePlanMode)。
      this.applyMode(native);
      agent?.setMode(native);
    };
    // 与 setMode 同语义的外层箭头闭包(捕获 kernel 的 this;返回对象里的方法 this 是 TurnHandle)。
    const setModelFn = (model: ModelRef): void => {
      this.currentModel = model;
      agent?.setModel(model);
    };
    return {
      async setPermissionMode(mode: PermissionMode): Promise<void> {
        setMode(mode);
      },
      async setModel(model: ModelRef): Promise<void> {
        setModelFn(model);
      },
      async interrupt(): Promise<void> {
        agent?.abort('interrupt');
      },
      async cancel(): Promise<void> {
        agent?.abort('cancel');
      },
    };
  }

  async probe(): Promise<KernelHealth> {
    return { ok: true, kernelId: this.id, detail: 'forgeax-core native kernel' };
  }
}
