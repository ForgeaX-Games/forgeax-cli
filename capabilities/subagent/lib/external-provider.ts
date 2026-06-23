// External-provider bridge — Phase 5 of forgeax-studio's multi-cli design.
//
// When a subagent's marketplace.manifest.json#agents[<type>].provider field is
// something other than "forgeax" (e.g. "claude-code"), cli's subagent tool
// delegates the run to the studio server via POST /api/subagent instead of
// spawning a local cli child instance.
//
// This module is the SSE-to-EventBus forwarder. It:
//   1. opens a streaming POST to ${FORGEAX_SERVER_URL}/api/subagent
//   2. drains the SSE one ChatEvent at a time
//   3. publishes each event onto the parent's local EventBus with
//      emitterId = subAgentId, so cli's own /ws broadcast carries it to the
//      studio UI — which renders it inside a <SubAgentCard> with a provider
//      badge (Phase 4 wiring).
//
// Keeps cli's bus as the single source of truth: a non-forgeax subagent's
// stream is indistinguishable from a forgeax one as far as session jsonl,
// hook plugins, and observers are concerned.

import type { EventBusAPI, Event } from "#src/core/types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:18900";

export interface ExternalProviderRunOpts {
  /** Subagent id from the marketplace manifest (becomes the emitterId on
   *  every forwarded event). */
  subAgentId: string;
  /** Parent instance id — used only for logging on the server side. */
  parentInstanceId: string;
  /** The task brief passed to the external provider. */
  task: string;
  /** Parent's EventBus — forwarded events are published here. */
  bus: EventBusAPI;
  /** Abort signal — propagated to the SSE fetch; aborting closes the stream
   *  which the server interprets as cancel. */
  signal: AbortSignal;
  /** Optional override (defaults to FORGEAX_SERVER_URL env or 127.0.0.1:18900). */
  serverBaseUrl?: string;
}

export interface ExternalProviderRunResult {
  ok: boolean;
  /** "end_turn" / "max_tokens" / "cancelled" / "error". */
  stopReason: string;
  /** Provider that actually serviced the run, as reported by the server. */
  providerId?: string;
  /** Aggregated assistant text (handy for tool return values). */
  text: string;
  /** Last error message, if any. */
  error?: string;
}

interface SseFrame {
  event?: string;
  data?: string;
}

async function* readSse(stream: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const frame: SseFrame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
      }
      if (frame.event || frame.data) yield frame;
    }
  }
}

function publishWithEmitter(bus: EventBusAPI, ev: Event, emitterId: string): void {
  // EventBus.publish() supports a second arg for the emitter id so observers
  // (UI, jsonl writer) see the event as coming from the sub-agent rather than
  // the host instance.
  bus.publish(ev, emitterId);
}

export async function runExternalSubAgent(
  opts: ExternalProviderRunOpts,
): Promise<ExternalProviderRunResult> {
  const baseUrl =
    opts.serverBaseUrl ??
    process.env.FORGEAX_SERVER_URL ??
    DEFAULT_BASE_URL;
  const url = `${baseUrl}/api/subagent`;

  const result: ExternalProviderRunResult = {
    ok: false,
    stopReason: "error",
    text: "",
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentInstanceId: opts.parentInstanceId,
        subAgentId: opts.subAgentId,
        task: opts.task,
      }),
      signal: opts.signal,
    });
  } catch (e) {
    result.error = `bridge fetch failed: ${(e as Error).message}`;
    return result;
  }

  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    result.error = `bridge HTTP ${res.status}: ${body.slice(0, 240)}`;
    return result;
  }
  if (!res.body) {
    result.error = "bridge: empty response body";
    return result;
  }

  const now = (): number => Date.now();

  try {
    for await (const frame of readSse(res.body)) {
      if (!frame.data) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (typeof payload.providerId === "string" && !result.providerId) {
        result.providerId = payload.providerId;
      }
      switch (frame.event) {
        case "agent-start":
          // First frame from server — no bus event needed; we record the
          // providerId tag (above) for return value.
          break;

        case "token": {
          const text = typeof payload.text === "string" ? payload.text : "";
          if (!text) break;
          result.text += text;
          publishWithEmitter(
            bus(opts.bus),
            { type: "stream:text", source: "assistant", ts: now(), payload: { text } },
            opts.subAgentId,
          );
          break;
        }

        case "thinking": {
          const text = typeof payload.text === "string" ? payload.text : "";
          if (!text) break;
          publishWithEmitter(
            bus(opts.bus),
            { type: "stream:thinking", source: "assistant", ts: now(), payload: { text } },
            opts.subAgentId,
          );
          break;
        }

        case "tool-call": {
          const name = typeof payload.name === "string" ? payload.name : "tool";
          const args = payload.args ?? {};
          const toolCallId = typeof payload.callId === "string" ? payload.callId : `call_${now()}`;
          publishWithEmitter(
            bus(opts.bus),
            {
              type: "hook:toolCall",
              source: "assistant",
              ts: now(),
              payload: { name, toolName: name, args, toolCallId },
            },
            opts.subAgentId,
          );
          break;
        }

        case "tool-result": {
          const toolCallId = typeof payload.callId === "string" ? payload.callId : `call_${now()}`;
          const ok = payload.ok !== false;
          const text =
            typeof payload.result === "string"
              ? payload.result
              : payload.result != null
              ? JSON.stringify(payload.result)
              : undefined;
          const error = typeof payload.error === "string" ? payload.error : undefined;
          const toolResultPayload: Record<string, unknown> = ok
            ? { toolCallId, llmMessage: { content: text ?? "" } }
            : { toolCallId, error: error ?? "tool failed" };
          publishWithEmitter(
            bus(opts.bus),
            { type: "hook:toolResult", source: "assistant", ts: now(), payload: toolResultPayload },
            opts.subAgentId,
          );
          break;
        }

        case "done": {
          const stopReason =
            typeof payload.stopReason === "string" ? payload.stopReason : "end_turn";
          result.stopReason = stopReason;
          result.ok = true;
          publishWithEmitter(
            bus(opts.bus),
            { type: "hook:turnEnd", source: "assistant", ts: now(), payload: { stopReason } },
            opts.subAgentId,
          );
          break;
        }

        case "error": {
          const message =
            typeof payload.message === "string" ? payload.message : "(no message)";
          result.error = message;
          result.stopReason = "error";
          publishWithEmitter(
            bus(opts.bus),
            { type: "hook:turnEnd", source: "assistant", ts: now(), payload: { stopReason: "error", error: message } },
            opts.subAgentId,
          );
          break;
        }
      }
    }
  } catch (e) {
    if (!opts.signal.aborted) {
      result.error = `bridge stream read failed: ${(e as Error).message}`;
    } else {
      result.stopReason = "cancelled";
      result.ok = false;
    }
  }

  return result;
}

// Tiny identity helper kept so future migrations (e.g. wrapping a sandboxed
// bus) only need to touch one spot rather than every publishWithEmitter call.
function bus(b: EventBusAPI): EventBusAPI {
  return b;
}
