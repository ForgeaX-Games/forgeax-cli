/**
 * transcribeKernelTurn —— 把一轮内核 turn **转录**进编排层 host-owned 账本。
 *
 * 核心目标(多内核通用·host-owned 历史):内核每轮吐的是中立 `KernelEvent` 流;编排层
 * 在此把它转录成 per-agent 账本的 canonical 事件,**与具体内核无关**(claude-code /
 * codex / forgeax-core 同一形状),账本即上下文真相,不依赖任何内核的私有会话文件。
 *
 * 两条铁律:
 *  1. **key 到 UI 重放用的同一个 (sid, agentPath)** —— `agentPath` 必须 = 客户端发消息
 *     时传的 agentId(store.ts 发送 + 刷新后 fetch_session_events(sid, agentId) 重放,
 *     逐字一致)。caller 负责传对;本函数不再做 `display===agentId / depth===1` 那种会
 *     落到别的节点的启发式解析(那正是"claude-code 刷新历史消失"的根因)。
 *  2. **直接写账本、不经 EventBus** —— caller(如 /api/cli/chat)已把同轮 SSE 直送前端;
 *     再经 bus 广播会在 WS 上重复渲染。账本路径只由 (sid, agentPath) 计算、append 时自建
 *     目录,无需 agent 已 scaffold。
 *
 * 形状对齐 native /messages 路径(user_input / hook:turnStart / hook:toolCall|toolResult /
 * hook:assistantMessage(llmMessage) / hook:turnEnd) → replay 即可还原。
 */
import type { Event } from "../core/types";
import type { Session } from "../core/session";

export interface KernelTurnRecord {
  /** 本轮用户输入文本(渲染 user 气泡)。 */
  message: string;
  /** 驱动本轮的内核/驱动 id(claude-code / codex / forgeax-core)。写进账本,
   *  刷新后 loadSession 据此还原 ForgeCard 的来源 badge(否则历史消息丢标记)。 */
  providerId?: string;
  /** 累计的 assistant 文本。 */
  asstText: string;
  /** 累计的 thinking 文本。 */
  thinkingText: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "cancelled";
  usage?: unknown;
  model?: string;
  toolEvents: Array<
    | { kind: "call"; callId: string; name: string; args: unknown }
    | { kind: "result"; callId: string; ok: boolean; result?: unknown; error?: string }
  >;
}

/** 把一轮内核 turn 转录进 `session` 下 `agentPath` 的 per-agent 账本。
 *  空轮(无文本/思考/工具)直接跳过,不落噪声。 */
export function transcribeKernelTurn(session: Session, agentPath: string, rec: KernelTurnRecord): void {
  if (!agentPath) return;
  if (!(rec.asstText.trim() || rec.thinkingText.trim() || rec.toolEvents.length)) return;

  const led = session.getOrCreateLedger(agentPath);
  const ap = agentPath;
  const t0 = Date.now();
  const ev = (o: Record<string, unknown>) => o as unknown as Event;

  const pid = rec.providerId;
  led.append(ev({ type: "user_input", ts: t0, source: "user", to: ap, handoff: "turn", payload: { content: rec.message } }));
  led.append(ev({ type: "hook:turnStart", ts: t0, source: `agent:${ap}`, payload: { turn: 1, ...(pid ? { providerId: pid } : {}) } }), ap);

  for (const t of rec.toolEvents) {
    if (t.kind === "call") {
      led.append(
        ev({
          type: "hook:toolCall",
          ts: Date.now(),
          source: `agent:${ap}`,
          payload: { name: t.name, args: t.args, callId: t.callId, toolCall: { id: t.callId, name: t.name, arguments: t.args } },
        }),
        ap,
      );
    } else {
      led.append(
        ev({
          type: "hook:toolResult",
          ts: Date.now(),
          source: `agent:${ap}`,
          payload: {
            name: "",
            callId: t.callId,
            ok: t.ok,
            durationMs: 0,
            ...(t.result !== undefined ? { result: t.result } : {}),
            ...(t.ok ? {} : { error: t.error ?? "tool failed" }),
          },
        }),
        ap,
      );
    }
  }

  if (rec.asstText.trim() || rec.thinkingText.trim()) {
    led.append(
      ev({
        type: "hook:assistantMessage",
        ts: Date.now(),
        source: `agent:${ap}`,
        payload: {
          llmMessage: {
            role: "assistant",
            content: [{ type: "text", text: rec.asstText }],
            ...(rec.thinkingText.trim() ? { thinking: rec.thinkingText } : {}),
          },
          turn: 1,
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.usage ? { usage: rec.usage } : {}),
          ...(pid ? { providerId: pid } : {}),
        },
      }),
      ap,
    );
  }

  led.append(ev({ type: "hook:turnEnd", ts: Date.now(), source: `agent:${ap}`, payload: { turn: 1, reason: rec.stopReason } }), ap);
}
