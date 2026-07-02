/** POST /api/cli/chat —— 临时 SSE 桥，让 interface 还能跟 claude-code 聊天。
 *
 *  R3 阶段定位（参考 docs/features/internal-loop-completion-plan.md §5）：
 *  - **独立 REST 分支**，不走 commands transport。
 *  - 标 `Deprecation: true` + `Sunset: forgeax-v1.0` —— 等原生 ScriptAgent /
 *    commands `attach_script_agent` 跑通后，这条整片下线。
 *  - 简化版砍掉旧实现的 runs / threads / event-log / SessionStore 持久化层；
 *    只保留 "POST 一句话 → SSE 一回合 → done/error 终止" 的最小核心。多轮上下文
 *    继续靠 claude-code 自带的 `--session-id` / `--resume`（provider 内部维持
 *    `startedThreadIds` set），threadId 由 caller（interface）提供。
 *
 *  请求体（与旧 chat.ts 子集兼容）：
 *    {
 *      message: string,           // 必填
 *      threadId?: string,         // UUID v4；缺则 provider 每次起独立 session（无续上下文）
 *      agentId?: string,          // 暂时只用于日志
 *      providerOverride?: string  // UI 选的内核 id(claude-code / codex / forgeax-core);内核路径据此 resolveKernel
 *    }
 *
 *  响应：text/event-stream，每条事件 `event: <type>\ndata: <json>\n\n`。
 *  事件类型来自 ChatEvent union（token / thinking / tool-call / tool-result / done / error）。
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  getDefaultProvider,
  getProvider,
  listProviders,
} from "../../cli-providers/registry";
import type { ChatEvent, ChatRequest } from "../../cli-providers/types";
import type { Session } from "../../core/session";
import { deprecation } from "../lib/deprecation";
import { getSessionManager } from "../../core/session-manager";
import { getCheckpointManager } from "../../checkpoint/checkpoint-manager";
import { getPathManager } from "../../fs/path-manager";
import { readFile } from "node:fs/promises";
import { CliEventBridge } from "../../observatory/cli-event-bridge";
import { denyPermissionsForSession } from "../../core/permission-registry";
// M1 内核路径(FORGEAX_KERNEL=kernel):chat → 内核契约 → wire,前端零改。
import { composeTurnRequest } from "../../kernel/compose-turn-request";
import { resolveKernel, listAvailableKernels } from "../../kernel/resolve-kernel";
import { toWireEvents, newWireFoldState } from "../../kernel/to-wire-events";
import { kernelEnabled } from "../../kernel/kernel-mode";
import { transcribeKernelTurn } from "../../kernel/transcribe-turn";
import { tt, ttEnabled } from "../../lib/turn-trace";
import { formatCacheHitRatio } from "../../lib/cache-ratio";

interface ChatBody {
  message?: string;
  agentId?: string;
  threadId?: string;
  sessionId?: string;
  providerOverride?: string;
  /** Doc 05 section 7 -- per-call id for `POST /api/cli/cancel`. */
  callId?: string;
  /** Doc 05 section 7 -- per-call deadline; the provider auto-aborts and
   *  surfaces `code: 'driver-timeout'` on expiry. */
  timeoutMs?: number;
  /** 多模态附件(图片)。每项 `{ kind:'image', mediaType, data?(base64) | path?(host 文件) }`。
   *  透传进 composeTurnRequest → TurnRequest.input.attachments → 原生内核 facade 组 image block。 */
  attachments?: Array<Record<string, unknown>>;
}

interface CancelBody {
  callId?: string;
  providerOverride?: string;
}

const DEPRECATION_NOTICE = deprecation({
  sunset: "forgeax-v1.0",
  reason: "cli-provider bridge is temporary; will be replaced by commands.attach_script_agent + ScriptAgent",
  migration: "/api/commands/attach_script_agent/execute (planned R5)",
});

export function createCliRouter() {
  const r = new Hono();

  // 所有 /api/cli/* 端点统一带 Deprecation header。
  r.use("*", DEPRECATION_NOTICE);

  // 健康检查 —— 让 interface 能 probe "claude 二进制有没有 / API key 设了没"。
  r.get("/health", async (c) => {
    const providers = listProviders();
    const snaps = await Promise.all(providers.map(async (p) => {
      const h = await p.health(1500);
      return { id: p.id, ok: h.ok, detail: h.detail, capabilities: p.capabilities };
    }));
    // 总体 ok 以 cli-provider(默认对话路径)为准 —— 第三方内核(codex/cursor)未装/
    // 不健康不应让整个输入框 disabled(R1-06)。
    const overallOk = snaps.length > 0 && snaps.every((s) => s.ok);
    // 内核路径(kernelEnabled,ship-gate 默认开):picker 还要能选 codex / cursor-agent /
    // forgeax-core —— chat 路径据 providerOverride 走 resolveKernel 真跑。把已注册内核并进
    // 列表(按 id 去重,claude-code 已由 cli-provider 覆盖则跳过),与能跑的集合一致。
    if (kernelEnabled()) {
      const seen = new Set(snaps.map((s) => s.id));
      for (const k of listAvailableKernels()) {
        if (seen.has(k.id)) continue;
        let h: { ok: boolean; detail?: string };
        try {
          h = await k.probe();
        } catch (e) {
          h = { ok: false, detail: (e as Error).message };
        }
        seen.add(k.id);
        // 把 KernelCapabilities 映射成 picker 期望的 ProviderCapabilities 形:
        // 内核经 threadId resume(sessions=true);子 agent 走编排层 handoff 而非内核内
        // (subAgents=false,保守);无 JSONL 回放语义。
        const cap = k.capabilities;
        snaps.push({
          id: k.id,
          ok: h.ok,
          detail: h.detail,
          capabilities: {
            streaming: cap.streaming,
            thinking: cap.thinking,
            toolCalls: cap.toolCalls,
            subAgents: false,
            sessions: true,
            jsonlReplay: false,
          },
        });
      }
    }
    if (snaps.length === 0) {
      return c.json({ ok: false, providers: [], detail: "no cli-provider registered" }, 503);
    }
    return c.json({ ok: overallOk, providers: snaps });
  });

  r.post("/chat", async (c) => {
    let body: ChatBody;
    try {
      body = (await c.req.json()) as ChatBody;
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const message = body?.message;
    if (typeof message !== "string" || !message.trim()) {
      return c.json({ ok: false, error: "message (non-empty string) required" }, 400);
    }

    // 写时迁移(plan B PR2-compat):若这是对一个 pre-PR2 老 session 发新消息,先把整份
    // 老 session 目录搬进当前项目 games/<slug>/sessions/<sid>/,确保新老记录都落项目下。
    // 幂等:已在项目内 / 非老 session → no-op。读路径(list/open 预览)不经此。
    if (body.sessionId) {
      try { await getSessionManager().prepareForWrite(body.sessionId); }
      catch (e) { console.warn(`[chat] prepareForWrite(${body.sessionId}) failed: ${(e as Error).message}`); }
    }

    // ── M1:新内核路径(FORGEAX_KERNEL=kernel)。compose → resolveKernel.runTurn →
    //    toWireEvents → SSE。前端按 event 名消费,零改。旧 cli-provider 路径见下方(默认 fallback)。
    if (kernelEnabled()) {
      const callId = typeof body.callId === "string" && body.callId.trim() ? body.callId.trim() : undefined;
      const agentId = body.agentId ?? "default";
      const turnReq = await composeTurnRequest({
        message,
        agentId,
        threadId: body.threadId,
        sessionId: body.sessionId,
        callId,
        ...(Array.isArray(body.attachments) && body.attachments.length ? { attachments: body.attachments } : {}),
      });

      // 历史持久化(host-owned,核心目标):内核每轮的 KernelEvent 流由编排层**转录**进
      // per-agent 账本 —— 与具体内核(claude-code / codex / forgeax-core)无关,账本是
      // 上下文真相,不依赖任何内核的私有会话。直接写账本(不经 eventBus,避免与 UI 已消费
      // 的 SSE 在 WS 上重复渲染),形状对齐 sessions 路径(user_input / hook:turnStart /
      // hook:toolCall|toolResult / hook:assistantMessage(llmMessage)/ hook:turnEnd),
      // replay 即可还原。
      //
      // ★ 账本必须 key 到「UI 重放用的同一个 (sid, agentPath)」。UI(store.ts)发消息时
      //   传 `agentId`、刷新后又用**同一个** `agentId`(= tab.agentId)调
      //   fetch_session_events(sid, agentId) 重放。此前用 `display===agentId || depth===1`
      //   的启发式解析会落到**另一个**节点 → claude-code/codex 的历史写错 key、刷新即"消失"。
      //   修复:直接以 `agentId` 为账本 key(账本路径只由 (sid, agentPath) 计算、append 时
      //   自建目录,无需 agent 已 scaffold),与 UI 重放键逐字一致 → 刷新历史恒在。
      let persistSession: Session | null = null;
      const persistAgent = agentId;
      if (body.sessionId) {
        try {
          persistSession = await getSessionManager().open(body.sessionId);
        } catch (e) {
          console.warn(`[cli/chat] ledger persist skipped: ${(e as Error).message}`);
        }
      }
      // checkpoint 定格:新用户消息到达 → 若有挂起的软回退,先定格(此后 UI 移除置灰段)。
      // 与原生 POST /api/sessions/:sid/messages 同语义 —— CLI 桥(cursor/claude-code 等)
      // 之前漏了这步,导致经 CLI provider 发消息时 rewind:finalized 永不触发,挂起态(置灰
      // + 「已回退到此处」)永久卡住。失败不阻塞聊天。
      if (persistSession) {
        try { getCheckpointManager().finalizePending(persistSession); } catch (e) {
          console.warn(`[cli/chat] finalizePending failed: ${(e as Error).message}`);
        }
      }

      return streamSSE(c, async (sse) => {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        c.req.raw.signal.addEventListener("abort", onAbort);
        const fold = newWireFoldState();
        // accumulate the turn for the WAL write in `finally`.
        let asstText = "";
        let thinkingText = "";
        let stopReason: "end_turn" | "tool_use" | "max_tokens" | "cancelled" = "end_turn";
        let usage: unknown;
        const toolEvents: Array<
          | { kind: "call"; callId: string; name: string; args: unknown }
          | { kind: "result"; callId: string; ok: boolean; result?: unknown; error?: string }
        > = [];
        // 内核 id 即 wire/账本的 providerId(claude-code / codex / forgeax-core)。
        // 在 try 外声明,让 finally 的账本转录也能拿到(刷新后据此还原来源 badge)。
        let providerId = "claude-code";
        try {
          // ★ honor UI 的 providerOverride(the reference agent CLI / Codex 选择),否则会被全局
          //   FORGEAX_KERNEL_IMPL(默认 forgeax-core)顶掉 → claude-code 消息被当成 forgeax。
          const kernel = resolveKernel(turnReq.session.agentId, body.providerOverride);
          providerId = kernel.id;
          for await (const kev of kernel.runTurn(turnReq, ac.signal)) {
            for (const wire of toWireEvents(kev, fold)) {
              const out: ChatEvent = { ...wire, providerId };
              await sse.writeSSE({ event: out.type, data: JSON.stringify(out) });
              switch (out.type) {
                case "token": asstText += out.text ?? ""; break;
                case "thinking": thinkingText += out.text ?? ""; break;
                case "tool-call": toolEvents.push({ kind: "call", callId: out.callId, name: out.name, args: out.args }); break;
                case "tool-result": toolEvents.push({ kind: "result", callId: out.callId, ok: out.ok, result: out.result, error: out.error }); break;
                case "done": {
                  stopReason = out.stopReason; usage = out.usage;
                  // 缓存命中率打点(还原老 studio 的 cachedRatio,迁移遗失)。
                  // 经通用 console 通道落该 session 的 <sid>/logs/debug.log(由
                  // app.ts 的 sessionScope 中间件给本请求建好 ALS sid 作用域),便于把
                  // 「子 agent 首轮应然 0」与「多轮前缀被击穿导致的回归 0」分开量。
                  // FORGEAX_TURN_TRACE 开才落盘。
                  if (ttEnabled() && out.usage) {
                    const u = out.usage;
                    tt("turn.usage", {
                      agent: agentId,
                      sid: body.sessionId,
                      provider: providerId,
                      input: u.inputTokens,
                      output: u.outputTokens,
                      cacheRead: u.cacheReadTokens,
                      cacheCreation: u.cacheCreationTokens,
                      cachedRatio: formatCacheHitRatio(
                        u.inputTokens ?? 0,
                        u.cacheReadTokens ?? 0,
                        u.cacheCreationTokens ?? 0,
                      ),
                    });
                  }
                  break;
                }
                default: break;
              }
              if (out.type === "done" || out.type === "error") return;
            }
          }
        } catch (err: any) {
          await sse.writeSSE({
            event: "error",
            data: JSON.stringify({ type: "error", message: err?.message ?? String(err), code: "kernel_unavailable" }),
          });
        } finally {
          c.req.raw.signal.removeEventListener("abort", onAbort);
          // Transcribe the kernel turn into the host-owned ledger (kernel-agnostic,
          // keyed to `persistAgent` = the agentId the UI replays with). Direct WAL
          // write, not via eventBus → no WS double-render against the SSE above.
          if (persistSession && persistAgent) {
            try {
              transcribeKernelTurn(persistSession, persistAgent, {
                message,
                asstText,
                thinkingText,
                stopReason,
                providerId,
                ...(usage ? { usage } : {}),
                ...(turnReq.model ? { model: turnReq.model } : {}),
                toolEvents,
              });
            } catch (e) {
              console.warn(`[cli/chat] ledger write failed: ${(e as Error).message}`);
            }
          }
        }
      });
    }

    const provider = body.providerOverride
      ? getProvider(body.providerOverride)
      : getDefaultProvider();
    if (!provider) {
      return c.json(
        { ok: false, error: `no cli-provider available${body.providerOverride ? ` (override="${body.providerOverride}")` : ""}` },
        503,
      );
    }

    // Pre-flight health —— 避免开了 SSE 才报 "claude 二进制找不到"。
    const h = await provider.health(1500);
    if (!h.ok) {
      return c.json({ ok: false, error: h.detail ?? `provider ${provider.id} unhealthy` }, 503);
    }

    const req: ChatRequest = {
      agentId: body.agentId ?? "default",
      message,
      threadId: body.threadId,
      sessionId: body.sessionId,
      callId: typeof body.callId === "string" && body.callId.trim() ? body.callId.trim() : undefined,
      timeoutMs: typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined,
    };

    // Stamp the resolved provider on the response stream so the cancel route
    // (which only sees callId) can short-circuit when the registry shape
    // changes mid-flight; the lifecycle wrapper inside provider.chat is the
    // one that actually owns the AbortController.
    // Observatory bridge — when the caller passes a forgeax sessionId we
    // also publish a translated copy of every ChatEvent onto the session's
    // EventBus so per-agent ledger persistence + observatory live SSE both
    // see the same turn. Skipped when sessionId is missing (legacy callers)
    // or the session can't be opened.
    let bridge: CliEventBridge | null = null;
    if (req.sessionId) {
      try {
        const session = await getSessionManager().open(req.sessionId);
        // checkpoint 定格:与 kernel 路径同语义(见上)。新用户消息 → 定格挂起的软回退,
        // 否则经 legacy CLI provider 发送时置灰段永不移除。失败不阻塞聊天。
        try { getCheckpointManager().finalizePending(session); } catch (e) {
          console.warn(`[cli/chat] finalizePending failed: ${(e as Error).message}`);
        }
        const node = session.tree.list().find((n) => n.display === req.agentId)
          ?? session.tree.list().find((n) => n.depth === 1)
          ?? null;
        const agentPath = node?.path ?? req.agentId;
        bridge = new CliEventBridge({ session, agentPath, model: provider.id });

        // Per-agent model selection: the ModelPicker writes the user's choice to
        // `agent.json::models.model` (via the `set_agent_models` command). That
        // file is the SSOT the forgeax runtime already consumes — but the
        // cli-provider bridge built `req` without it, so providers like
        // claude-code fell back to the CLI's built-in default (looked like the
        // picker "did nothing"). Resolve it here and forward as a provider
        // override (types.ts: `options` = "provider-specific overrides … model")
        // so the selected model actually reaches whichever provider runs.
        // Candidate paths: prefer the exact agentPath the ModelPicker wrote to
        // (req.agentId — the UI sends the active tab's agent path, which is the
        // same value `set_agent_models` keys on), then the tree-resolved path.
        // First candidate that yields a models.model wins.
        const pm = getPathManager();
        const candidates = Array.from(new Set([req.agentId, agentPath].filter(Boolean)));
        for (const cand of candidates) {
          try {
            const cfg = JSON.parse(await readFile(pm.session(req.sessionId).agent(cand).agentJson(), "utf8")) as {
              models?: { model?: string | string[] | null };
            };
            const raw = cfg.models?.model;
            const model = Array.isArray(raw)
              ? raw.find((m) => typeof m === "string" && m.trim())?.trim()
              : typeof raw === "string" && raw.trim()
                ? raw.trim()
                : undefined;
            if (model) { req.options = { ...(req.options ?? {}), model }; break; }
          } catch {
            /* this candidate has no agent.json / unreadable → try next */
          }
        }
      } catch (e) {
        console.warn(`[cli/chat] observatory bridge skipped: ${(e as Error).message}`);
      }
    }

    return streamSSE(c, async (sse) => {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      c.req.raw.signal.addEventListener("abort", onAbort);

      bridge?.start();
      let endStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' = 'end_turn';
      let endDurationMs: number | undefined;
      let endUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined;
      let endEmitted = false;
      const finishBridge = () => {
        if (!bridge || endEmitted) return;
        endEmitted = true;
        bridge.end(endStopReason, endDurationMs, endUsage);
      };

      try {
        for await (const ev of provider.chat(req, ac.signal)) {
          // 把 providerId 也回写到事件（旧实现里在 mapper 出口已经 stamped；这里
          // 兼容性兜底）。
          const out: ChatEvent = { ...ev, providerId: ev.providerId ?? provider.id };
          await sse.writeSSE({
            event: out.type,
            data: JSON.stringify(out),
          });
          if (bridge) {
            if (out.type === 'done') {
              endStopReason = out.stopReason;
              endDurationMs = out.durationMs;
              endUsage = out.usage;
            } else if (out.type === 'error') {
              endStopReason = 'cancelled';
            }
            bridge.forward(out);
          }
          if (out.type === "done" || out.type === "error") break;
        }
      } catch (err: any) {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", message: err?.message ?? String(err), providerId: provider.id }),
        });
        endStopReason = 'cancelled';
      } finally {
        finishBridge();
        // A blocked permission card belongs to THIS turn. When the turn ends
        // (naturally, on error, or because the user cancelled / sent a new
        // message → the subprocess is terminated, which also kills the MCP
        // permission child and drops its HTTP call), release any permission
        // still pending for this thread. The held /permission-request then
        // resolves fail-closed *now* and its finally publishes
        // `permission:resolved` → the UI card dismisses — instead of lingering
        // for 10 minutes against a turn whose subprocess is already gone.
        // sid + agent recompute exactly what claude-code.ts fed the MCP server
        // (FORGEAX_SID / FORGEAX_AGENT). No-op on a normal turn (the answered
        // request was already removed from the registry).
        const permSid = req.threadId?.trim() || req.sessionId?.trim() || "";
        if (permSid) {
          try {
            denyPermissionsForSession(permSid, req.agentId?.trim() || "forge");
          } catch (e) {
            console.warn(`[cli/chat] permission cleanup failed: ${(e as Error).message}`);
          }
        }
        c.req.raw.signal.removeEventListener("abort", onAbort);
      }
    });
  });

  // POST /api/cli/cancel -- Doc 05 section 7 cancel channel. Calls
  // provider.cancel(callId) so the in-flight chat aborts and emits its
  // `{ type: 'done', stopReason: 'cancelled', code: 'cancelled' }` terminal
  // on its own SSE stream. Idempotent: unknown callIds return ok:true so
  // the UI can fire-and-forget without races against natural completion.
  r.post("/cancel", async (c) => {
    let body: CancelBody;
    try {
      body = (await c.req.json()) as CancelBody;
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const callId = typeof body.callId === "string" ? body.callId.trim() : "";
    if (!callId) {
      return c.json({ ok: false, error: "callId (non-empty string) required" }, 400);
    }
    const provider = body.providerOverride
      ? getProvider(body.providerOverride)
      : getDefaultProvider();
    if (!provider) {
      return c.json(
        { ok: false, error: `no cli-provider available${body.providerOverride ? ` (override="${body.providerOverride}")` : ""}` },
        503,
      );
    }
    if (typeof provider.cancel !== "function") {
      return c.json({ ok: false, error: `provider ${provider.id} does not support cancel` }, 501);
    }
    try {
      await provider.cancel(callId);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message ?? String(err) }, 500);
    }
    return c.json({ ok: true, callId, providerId: provider.id });
  });

  return r;
}
