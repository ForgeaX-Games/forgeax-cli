/**
 * Core event catalog (C1) — the canonical event type names + payload typing.
 *
 * 设计稿: 最终实现方案 §3 (events.ts 事件目录) + §4。事件流是真相，派生状态是 fold
 * 结果（不变量 §6.1）。`CoreEventType` 是稳定字符串枚举；payload 类型挂在
 * `CoreEventPayloads` 上，供 typed publish/subscribe 收窄。
 *
 * 含三个**重生事件**（数字生命 seam，core-layer-spec §3.4.8）——core 只 publish，
 * 语义由 ③ soul-pack cli pack 解释（K14）。
 */
import type { LoopStage, TerminalReason } from '../agent/types';
import type {
  SoulPackLoadedPayload,
  RebirthInitiatedPayload,
  IdentityProjectedPayload,
} from '../capability/memory-seam';

export const CoreEventType = {
  // turn lifecycle
  TurnStart: 'turn.start',
  TurnEnd: 'turn.end',
  TurnAborted: 'turn.aborted',
  // loop stages
  CapabilitiesResolved: 'capabilities.resolved',
  SystemPromptAssembled: 'system_prompt.assembled',
  // tool call
  ToolCallRequested: 'tool.requested',
  ToolCalled: 'tool.called',
  ToolCallResult: 'tool.result',
  // compaction (ledger fold consumes these)
  CompactionApplied: 'compaction.applied',
  CompactionRevoked: 'compaction.revoked',
  /** ★ T5:上游 API 即将重试(观测事件;facade 映射成 api_retry KernelEvent 出墙)。
   *  纯观测,不进 ledger fold、不影响重试决策。 */
  ApiRetry: 'api.retry',
  // rewind (ledger fold consumes these; 遮蔽区间、无 replacement,区别于 compaction 的替换)
  RewindApplied: 'rewind.applied',
  RewindRevoked: 'rewind.revoked',
  // capability hot-reload
  CapabilityReloaded: 'capability.reloaded',
  // ★ hook 生命周期事件（session/prompt/compaction/notification/stop）。
  //   PostToolUse 不另设成员——它复用 ToolCallResult('tool.result')。
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'user_prompt.submit',
  PreCompact: 'compaction.pre',
  PostCompact: 'compaction.post',
  /** ★ 压缩被治理机制拦下(04.4:skip 不再静默)。仅在「阈值已达却没压」时发
   *  (below-threshold/disabled 属常态不触发,不发,防每轮刷 WAL)。 */
  CompactionSkipped: 'compaction.skipped',
  /** ★ 压缩管线失败(04.4:失败不再静默)。发生即发,与熔断计数 +1 同步。 */
  CompactionFailed: 'compaction.failed',
  Notification: 'notification',
  /** 专用 stop 事件；后续阶段将 REPLACE loop 里临时的 'stop.hook' 字符串。 */
  Stop: 'stop',
  SubagentStop: 'subagent.stop',
  /** ★ 子 agent 启动:子 loop fork 出来时发,携类型/角色/深度。 */
  SubagentStart: 'subagent.start',
  /** ★ 子 agent 进入新一轮:每轮起点发,携轮号/深度。 */
  SubagentTurn: 'subagent.turn',
  /** ★ 子 agent 工具调用:子 loop 调工具时发,携工具名/toolUseId/轮号/深度。 */
  SubagentToolCall: 'subagent.tool_call',
  /** ★ 子 agent 进度:子 loop 自报进度文本(可选轮号)。 */
  SubagentProgress: 'subagent.progress',
  /** ★ peer 消息(多 agent 协作 seam):一个 agent → 另一个 agent 的点对点消息。
   *  core 只 publish,由 host(多 agent session bus / 调度器)负责路由投递。 */
  AgentMessage: 'agent.message',
  // ★ 重生事件（数字生命转世 seam）
  SoulPackLoaded: 'soul.pack_loaded',
  RebirthInitiated: 'soul.rebirth_initiated',
  IdentityProjected: 'soul.identity_projected',
} as const;

export type CoreEventType = (typeof CoreEventType)[keyof typeof CoreEventType];

/** 各事件的 payload 类型（typed publish 用；未列的事件 payload=unknown）。 */
export interface CoreEventPayloads {
  [CoreEventType.TurnStart]: { turn: number };
  [CoreEventType.TurnEnd]: { turn: number; usageContextRatio?: number };
  [CoreEventType.TurnAborted]: { turn: number; reason?: string };
  [CoreEventType.CapabilitiesResolved]: { toolNames: string[] };
  [CoreEventType.SystemPromptAssembled]: { blockCount: number };
  [CoreEventType.ToolCallRequested]: { toolName: string; toolUseId: string; input: unknown };
  [CoreEventType.ToolCalled]: { toolName: string; toolUseId: string };
  /**
   * 工具调用结果。亦充当 PostToolUse hook 的载荷——故额外携带 `toolName`/`result`
   * （additive 加宽，原 `{ toolUseId; isError? }` 字段保持 byte-stable）。
   */
  [CoreEventType.ToolCallResult]: {
    toolUseId: string;
    toolName?: string;
    result?: unknown;
    isError?: boolean;
  };
  /**
   * 压缩落地事件(ledger fold 消费 coveredFrom/coveredTo/replacement)。
   * ★ T5 additive:另携三个可选观测字段(fold 不读,纯供 facade → compact_boundary 出墙):
   *   `preTokens`/`postTokens` = 压缩前后会话 token 估算;`trigger` = 触发原因(auto/manual/...)。
   *   老发布方不带这三字段 → facade 优雅降级(字段为 undefined),零回归。
   */
  [CoreEventType.CompactionApplied]: {
    coveredFrom: number;
    coveredTo: number;
    replacement: unknown;
    preTokens?: number;
    postTokens?: number;
    trigger?: string;
  };
  [CoreEventType.CompactionRevoked]: { appliedId: string };
  /** ★ T5:上游 API 重试观测。attempt = 刚失败的尝试序号(1 起);reason = 触发原因
   *  (如 '429'/'529'/'500'/'overloaded'/'stream_idle'/'fallback');retryAfterMs = 服务端退避。 */
  [CoreEventType.ApiRetry]: { attempt: number; reason: string; retryAfterMs?: number };
  /**
   * 对话回退 boundary(append-only,事件流是真相 §6.1)。语义 = **遮蔽**从第
   * `keepUserTurns` 个用户轮(0-based)起、直到本事件之前的全部会话事件——无 replacement
   * (区别于 compaction 的替换)。本事件之后 append 的新轮次不受影响,故一次 rewind→续聊→
   * 再 rewind 天然叠加。`rewindId` 供 RewindRevoked(Redo/cancel)按 id 撤销。 */
  [CoreEventType.RewindApplied]: { rewindId: string; keepUserTurns: number };
  /** 撤销一次 rewind(Redo/cancel):按 `rewindId` 寻址,被遮蔽轮次恢复。原事件不删。 */
  [CoreEventType.RewindRevoked]: { rewindId: string };
  [CoreEventType.CapabilityReloaded]: { packName: string };
  // ★ hook 生命周期事件的 payload。
  /** 会话开始：哪个 session、工作目录、触发来源。 */
  [CoreEventType.SessionStart]: { sessionId?: string; cwd?: string; source?: string };
  /** 会话结束：哪个 session、结束原因。 */
  [CoreEventType.SessionEnd]: { sessionId?: string; reason?: string };
  /** 用户提交 prompt：本轮 prompt 文本 + 第几轮 + 回退锚点 msgId(H-02:host 在 checkpointTurn
   *  生成,写进 WAL 与 checkpoints.jsonl 同一个 id;rehydrate 据此让 /resume 后历史轮的文件回退
   *  可用。旧 WAL 无此字段 → rehydrate 走 ordinal fallback)。 */
  [CoreEventType.UserPromptSubmit]: { prompt: string; turn: number; msgId?: string };
  /** 压缩前：触发方式(auto/manual) + 当前 token 数。 */
  [CoreEventType.PreCompact]: { trigger?: 'auto' | 'manual'; tokenCount?: number };
  /** 压缩后:被压缩覆盖的消息区间。 */
  [CoreEventType.PostCompact]: { coveredFrom: number; coveredTo: number };
  /** 压缩被拦:拒绝原因(gate reject reason / hook-blocked / nothing-to-compact)+ 触发上下文。 */
  [CoreEventType.CompactionSkipped]: {
    reason: string;
    trigger?: 'auto' | 'manual';
    type?: string;
    tokenCount?: number;
  };
  /** 压缩失败:错误文案 + 触发上下文(与 gate 熔断计数 +1 同步发)。 */
  [CoreEventType.CompactionFailed]: {
    error: string;
    trigger?: 'auto' | 'manual';
    type?: string;
    tokenCount?: number;
  };
  /** 通知:消息文本 + 可选级别。 */
  [CoreEventType.Notification]: { message: string; level?: string };
  /**
   * 停止 hook：loop 从 publish receipt 上读 `preventStop`/`reason`
   * （镜像当前 'stop.hook' 的形状）。
   */
  [CoreEventType.Stop]: { turn: number; preventStop?: boolean; reason?: string; stopHookActive?: boolean };
  /** 子 agent 停止:子 agent 标识、类型、终态原因、轮数与工具调用数。 */
  [CoreEventType.SubagentStop]: {
    agentId?: string;
    agentType?: string;
    terminalReason?: string;
    turns?: number;
    toolCalls?: number;
  };
  /** 子 agent 启动:子 agent 标识、类型、角色、递归深度。 */
  [CoreEventType.SubagentStart]: { agentId: string; agentType?: string; role?: string; depth?: number };
  /** 子 agent 进入新一轮:子 agent 标识、轮号、递归深度。 */
  [CoreEventType.SubagentTurn]: { agentId: string; turn: number; depth?: number };
  /** 子 agent 工具调用:子 agent 标识、工具名、toolUseId、轮号、递归深度。 */
  [CoreEventType.SubagentToolCall]: { agentId: string; toolName: string; toolUseId: string; turn?: number; depth?: number };
  /** 子 agent 进度:子 agent 标识、进度文本、轮号。 */
  [CoreEventType.SubagentProgress]: { agentId: string; message?: string; turn?: number };
  /**
   * peer 消息(多 agent 协作):`from` 发送方 agentId,`to` 目标 agentId(寻址用;
   * 缺省/广播由 host 解释),`content` 消息体(文本或结构化),`replyTo` 可选关联上一条。
   */
  [CoreEventType.AgentMessage]: {
    from?: string;
    to?: string;
    content: unknown;
    replyTo?: string;
  };
  [CoreEventType.SoulPackLoaded]: SoulPackLoadedPayload;
  [CoreEventType.RebirthInitiated]: RebirthInitiatedPayload;
  [CoreEventType.IdentityProjected]: IdentityProjectedPayload;
}

/** loop 阶段 → 事件名映射（stage publish 用）。 */
export const STAGE_EVENT: Record<LoopStage, string> = {
  resolve_capabilities: CoreEventType.CapabilitiesResolved,
  assemble_system_prompt: CoreEventType.SystemPromptAssembled,
  context_compaction: CoreEventType.CompactionApplied,
  provider_call: 'provider.call',
  dispatch_tools: CoreEventType.ToolCallRequested,
  turn_end: CoreEventType.TurnEnd,
  handoff_decision: 'handoff.decision',
};

/** 终态 reason → 是否正常完成（telemetry/facade 用）。 */
export function isCleanTerminal(reason: TerminalReason): boolean {
  return reason === 'completed';
}
