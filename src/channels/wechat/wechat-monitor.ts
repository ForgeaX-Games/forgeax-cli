// @desc WeChat monitor — long-poll inbound loop + WS outbound listener bridging iLink ↔ Gateway

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";

import { getUpdates, sendTyping, getConfig } from "./wechat-api.js";
import { MessageItemType, TypingStatus } from "./wechat-types.js";
import type { WeixinMessage, MessageItem } from "./wechat-types.js";
import { downloadImage, uploadAndSendMedia, sendMessageItems } from "./wechat-media.js";
import {
  loadSyncBuf, saveSyncBuf, setContextToken, getContextToken, clearContextToken,
  loadReplyTargets, saveReplyTargets, saveContextTokens,
  enqueuePending, drainPending,
} from "./wechat-store.js";
import { formatEventForWeChat, type WeChatEvent, type MediaAttachment } from "./wechat-format.js";
import type { ContentPart } from "../../core/types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1000;

export interface MonitorOpts {
  baseUrl: string;
  token: string;
  ws: WebSocket;
  instanceId: string;
  agentId?: string;
  abortSignal?: AbortSignal;
  log: (msg: string) => void;
}

// ── Inbound: extract content from WeixinMessage ──

function extractTextFromMessage(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function findImageItem(msg: WeixinMessage): MessageItem | null {
  return msg.item_list?.find(
    (i) => i.type === MessageItemType.IMAGE && i.image_item?.media?.encrypt_query_param,
  ) ?? null;
}

// ── Send text to WeChat (with retry + buffer on token exhaustion) ──

const TOKEN_EXPIRED_RET = -2;

async function sendTextToWeChat(params: {
  to: string;
  text: string;
  baseUrl: string;
  token: string;
  contextToken?: string;
  log?: (msg: string) => void;
}): Promise<void> {
  if (!params.contextToken) {
    params.log?.(`outbound: no context_token for ${params.to}, buffering`);
    enqueuePending(params.to, params.text);
    return;
  }
  const item: MessageItem = { type: MessageItemType.TEXT, text_item: { text: params.text } };
  try {
    const resp = await sendMessageItems([item], {
      to: params.to,
      opts: { baseUrl: params.baseUrl, token: params.token, contextToken: params.contextToken },
    });
    if (resp?.context_token) {
      setContextToken(params.to, resp.context_token);
      saveContextTokens();
    }
  } catch (err) {
    const isTokenError = err instanceof Error
      && (err as any).sendMessageResp?.ret === TOKEN_EXPIRED_RET;
    if (isTokenError) {
      clearContextToken(params.to);
      params.log?.(`outbound: context_token exhausted (ret=${TOKEN_EXPIRED_RET}), buffering — send a message in WeChat to refresh`);
      enqueuePending(params.to, params.text);
      return;
    }
    throw err;
  }
}

// ── Send media to WeChat ──

async function sendMediaToWeChat(
  media: MediaAttachment,
  ctx: { to: string; baseUrl: string; token: string; contextToken?: string; log: (msg: string) => void },
): Promise<void> {
  if (!ctx.contextToken) {
    ctx.log(`outbound: no context_token for ${ctx.to}, dropping media`);
    return;
  }
  let filePath = media.path;
  if (!filePath && media.data) {
    const tmp = join(tmpdir(), `agenteam-media-${randomUUID()}.${media.mimeType?.split("/")[1] ?? "bin"}`);
    await writeFile(tmp, Buffer.from(media.data, "base64"));
    filePath = tmp;
  }
  if (!filePath) return;

  await uploadAndSendMedia({
    filePath,
    mediaType: media.type,
    to: ctx.to,
    opts: { baseUrl: ctx.baseUrl, token: ctx.token, contextToken: ctx.contextToken },
  });
  ctx.log(`outbound: sent ${media.type} to=${ctx.to} path=${filePath}`);
}

// ── Typing ticket cache ──

const typingTickets = new Map<string, string>();

async function refreshTypingTicket(
  baseUrl: string, token: string, userId: string, contextToken?: string,
): Promise<string | undefined> {
  try {
    const resp = await getConfig({ baseUrl, token, ilinkUserId: userId, contextToken });
    if (resp.typing_ticket) {
      typingTickets.set(userId, resp.typing_ticket);
      return resp.typing_ticket;
    }
  } catch { /* best effort */ }
  return typingTickets.get(userId);
}

// ── Main loops ──

/**
 * Inbound loop: long-poll getUpdates from iLink, forward messages to Gateway via WS emit.
 */
export async function runInboundLoop(opts: MonitorOpts): Promise<void> {
  const { baseUrl, token, ws, instanceId, log } = opts;
  const agentId = opts.agentId;

  let getUpdatesBuf = loadSyncBuf();
  if (getUpdatesBuf) {
    log(`resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  }

  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!opts.abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
        if (isSessionExpired) {
          log(`session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing for 1 hour`);
          await sleep(SESSION_PAUSE_MS, opts.abortSignal);
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures++;
        log(`getUpdates error: ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, opts.abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, opts.abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        saveSyncBuf(resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        const fromUserId = msg.from_user_id ?? "";
        const text = extractTextFromMessage(msg);

        if (msg.context_token) {
          setContextToken(fromUserId, msg.context_token);
          saveContextTokens();

          const pending = drainPending(fromUserId);
          if (pending.length) {
            const merged = pending.map((m) => m.text).join("\n\n---\n\n");
            log(`inbound: flushing ${pending.length} pending message(s) as 1 merged send for ${fromUserId}`);
            try {
              await sendTextToWeChat({
                to: fromUserId, text: merged, baseUrl, token,
                contextToken: getContextToken(fromUserId), log,
              });
            } catch { /* already logged inside sendTextToWeChat */ }
          }
        }

        log(`inbound: from=${fromUserId} text="${text.slice(0, 40)}${text.length > 40 ? "…" : ""}" items=[${(msg.item_list ?? []).map(i => `type=${i.type}`).join(",")}]`);
        const imageItem = findImageItem(msg);
        let imagePath: string | null = null;
        if (imageItem?.image_item) {
          imagePath = await downloadImage(imageItem.image_item, log);
        }

        let content: string | ContentPart[];
        if (imagePath) {
          const parts: ContentPart[] = [];
          if (text) parts.push({ type: "text", text });
          // WeChat caches attachments on the host — mark part as host path so
          // readMediaBytes skips the sandbox bridge.
          parts.push({ type: "image_file", path: imagePath, mimeType: "image/jpeg", inContainer: false });
          content = parts;
        } else {
          content = text;
        }

        if (!content || (typeof content === "string" && !content.trim())) continue;

        const targetAgent = agentId || fromUserId;

        trackReplyTarget(targetAgent, fromUserId);

        ws.send(JSON.stringify({
          type: "emit",
          instanceId,
          event: {
            source: "user",
            type: "user_input",
            payload: { content },
            to: targetAgent,
            ts: Date.now(),
          },
        }));

        const ticket = await refreshTypingTicket(baseUrl, token, fromUserId, msg.context_token);
        if (ticket) {
          sendTyping({
            baseUrl, token,
            body: { ilink_user_id: fromUserId, typing_ticket: ticket, status: TypingStatus.TYPING },
          }).catch(() => {});
        }
      }
    } catch (err) {
      if (opts.abortSignal?.aborted) return;
      consecutiveFailures++;
      log(`getUpdates error: ${String(err)} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, opts.abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, opts.abortSignal);
      }
    }
  }
}

/** agentId (or "agent:xxx" source) → most recent WeChat userId */
const replyTargets = new Map<string, string>(Object.entries(loadReplyTargets()));

/** Record who last messaged a given agent, called by inbound loop. */
export function trackReplyTarget(agentId: string, wechatUserId: string): void {
  replyTargets.set(agentId, wechatUserId);
  saveReplyTargets(Object.fromEntries(replyTargets));
}

function resolveAgentId(source: string): string {
  if (source.startsWith("agent:")) {
    const id = source.slice("agent:".length);
    if (replyTargets.has(id)) return id;
  }
  if (replyTargets.has(source)) return source;
  if (source.startsWith("tool:") || source.startsWith("system:")) {
    const first = replyTargets.keys().next().value;
    if (first) return first;
  }
  return source;
}

function extractAssistantText(payload: Record<string, unknown>): string {
  const llmMsg = payload.llmMessage as { content?: string | unknown[] } | undefined;
  if (!llmMsg) return "";
  if (typeof llmMsg.content === "string") return llmMsg.content;
  if (Array.isArray(llmMsg.content)) {
    return (llmMsg.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("");
  }
  return "";
}

/**
 * Outbound listener: debounce rapid WS events into merged sendMessage calls
 * to conserve the ~10-reply-per-context_token quota imposed by iLink.
 */
export function setupOutboundListener(opts: MonitorOpts): void {
  const { baseUrl, token, ws, instanceId, log } = opts;

  const FORWARDED_TYPES = new Set([
    "hook:assistantMessage",
    "hook:toolResult",
    "agent_log",
    "message",
  ]);

  const DEBOUNCE_MS = 3_000;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const debounceBufs = new Map<string, string[]>();

  function flushDebounced(wechatUserId: string): void {
    const timer = debounceTimers.get(wechatUserId);
    if (timer) clearTimeout(timer);
    debounceTimers.delete(wechatUserId);

    const parts = debounceBufs.get(wechatUserId);
    debounceBufs.delete(wechatUserId);
    if (!parts?.length) return;

    const merged = parts.join("\n\n---\n\n");
    const contextToken = getContextToken(wechatUserId);
    sendTextToWeChat({ to: wechatUserId, text: merged, baseUrl, token, contextToken, log })
      .then(() => log(`outbound: to=${wechatUserId} merged=${parts.length} textLen=${merged.length}`))
      .catch((err) => log(`outbound merged error: ${String(err)}`));
  }

  function enqueueText(wechatUserId: string, text: string): void {
    const buf = debounceBufs.get(wechatUserId) ?? [];
    buf.push(text);
    debounceBufs.set(wechatUserId, buf);

    const existing = debounceTimers.get(wechatUserId);
    if (existing) clearTimeout(existing);
    debounceTimers.set(wechatUserId, setTimeout(() => flushDebounced(wechatUserId), DEBOUNCE_MS));
  }

  function cancelTyping(wechatUserId: string): void {
    const ticket = typingTickets.get(wechatUserId);
    if (ticket) {
      sendTyping({
        baseUrl, token,
        body: { ilink_user_id: wechatUserId, typing_ticket: ticket, status: TypingStatus.CANCEL },
      }).catch(() => {});
    }
  }

  ws.on("message", async (raw: Buffer) => {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }

    if (frame.type !== "event") return;
    if (frame.instanceId !== instanceId) return;

    const event = frame.event as Record<string, unknown>;
    if (!event) return;

    const payload = event.payload as Record<string, unknown> ?? {};
    const eventType = event.type as string;

    const hasError = Boolean(payload.error);
    const hasWarning = Boolean(payload.warning);
    const shouldForward = FORWARDED_TYPES.has(eventType) || hasError || hasWarning;
    if (!shouldForward) return;

    // Prefer EventBus-stamped emitterId; fall back to source parsing for tool/system events.
    const frameEmitterId = frame.emitterId as string | undefined;
    const agentId = (frameEmitterId && replyTargets.has(frameEmitterId))
      ? frameEmitterId
      : resolveAgentId(event.source as string);
    const wechatUserId = replyTargets.get(agentId);
    if (!wechatUserId) return;

    if (eventType === "hook:assistantMessage" && !hasError && !hasWarning) {
      cancelTyping(wechatUserId);
      const text = extractAssistantText(payload);
      if (text) enqueueText(wechatUserId, text);
      return;
    }

    if (hasError) cancelTyping(wechatUserId);

    const stored: WeChatEvent = {
      type: eventType, ts: Date.now(),
      source: event.source as string, payload,
    };
    const result = formatEventForWeChat(stored);
    if (!result) return;

    if (result.text) enqueueText(wechatUserId, result.text);

    const contextToken = getContextToken(wechatUserId);
    for (const media of result.media) {
      try {
        await sendMediaToWeChat(media, { to: wechatUserId, baseUrl, token, contextToken, log });
      } catch (err) {
        log(`outbound ${eventType} media error: ${String(err)}`);
      }
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}
