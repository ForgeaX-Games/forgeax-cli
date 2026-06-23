/** @desc CLI — agent interaction commands (list agents via commands transport, chat via emit) */

import { type ConnInfo, apiCall, print, die, extractFlag } from "./http.js";
import { connectGatewayWs } from "../../channels/shared/gateway-conn.js";

export async function cmdAgents(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = extractFlag(args, "--instance") ?? "default";
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instId)}/commands/list_agents/query`, { args: {} });
  if (status >= 400) die(JSON.stringify(data));
  const r = (data as { result?: { ok?: boolean; data?: unknown; error?: string } })?.result;
  if (!r?.ok) die(r?.error ?? "list_agents failed");
  print(r.data);
}

export async function cmdChat(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = extractFlag(args, "--instance") ?? "default";
  const streamJson = args.includes("--stream-json");
  // Strip --stream-json from positional args so message reconstruction works.
  const positional = args.filter((a) => a !== "--stream-json");
  const agentId = positional[0];
  const content = positional.slice(1).join(" ");
  if (!agentId || !content) {
    die("Usage: agenteam chat <agentId> <message> [--instance <id>] [--stream-json]");
  }

  if (streamJson) {
    // P5 (a): stream-json mode for cli-providers integration.
    //
    // Subscribe to the gateway WS BEFORE emitting the user message so we
    // don't miss the first response event (the cli emits events
    // synchronously from /emit handler back into its EventBus, which the WS
    // gateway broadcasts immediately).
    //
    // Each broadcast event is { type: "event", instanceId, event, emitterId,
    // seq }. We filter by instanceId locally — the WS gateway broadcasts
    // every event from every instance to every authed client. The cli emits
    // each ndjson line `{instanceId, event: StoredEvent, emitterId, seq}`
    // on stdout. server-side ForgeaXCliProvider (Phase b) will translate
    // StoredEvent → ChatEvent; for now we output raw to keep changes minimal.
    await runStreamJsonChat(conn, instId, agentId, content);
    return;
  }

  // Legacy fire-and-forget path: emit user_input + print server response.
  const { status, data } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/emit`,
    {
      event: {
        source: "user",
        type: "user_input",
        to: agentId,
        payload: { content },
        handoff: "turn",
      },
    },
  );
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

/** Stream-json chat: open WS, emit user_input, drain events filtered by
 *  instanceId until hook:turnEnd. Each event → one ndjson line on stdout.
 *  Exits 0 on turnEnd; non-zero on error frame.
 *
 *  Note: SIGTERM (the studio's spawnJsonl kill-on-cancel path) terminates
 *  the cli — node's default SIGTERM handler exits without flushing stdout,
 *  but for this case that's fine because spawnJsonl is closing the pipe
 *  anyway. */
async function runStreamJsonChat(
  conn: ConnInfo,
  instId: string,
  agentId: string,
  content: string,
): Promise<void> {
  // STREAM_JSON_DEBUG=1 to see ws auth + per-frame debug on stderr (useful
  // for diagnosing "no events arriving" when an agent's LLM key is missing).
  const dbg = process.env.STREAM_JSON_DEBUG === "1";
  const ws = await connectGatewayWs(conn);
  if (dbg) process.stderr.write(`[stream-json] WS authed, instId=${instId}\n`);

  // Promise that resolves when we see the turnEnd event (or rejects on error).
  // Resolve early on SIGTERM so the parent's spawnJsonl can clean up.
  const turnEnded = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
    let resolved = false;
    const onTerm = (): void => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, reason: "SIGTERM" });
    };
    process.once("SIGTERM", onTerm);

    ws.on("message", (raw: Buffer) => {
      if (resolved) return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }
      if (dbg) process.stderr.write(`[stream-json] frame type=${frame.type} instanceId=${frame.instanceId}\n`);
      if (frame.type !== "event") return;
      if (frame.instanceId !== instId) return;   // event from another instance
      // Emit ndjson line for this event. spawnJsonl reads stdout line-by-line.
      process.stdout.write(JSON.stringify(frame) + "\n");
      const ev = frame.event as { type?: string } | undefined;
      // Terminal events: turnEnd (success) or any error path. The cli's
      // event taxonomy uses hook:turnEnd for normal completion + hook:error
      // for failures. SubAgentSwitcher's status logic already keys on these.
      if (ev?.type === "hook:turnEnd") {
        resolved = true;
        process.off("SIGTERM", onTerm);
        resolve({ ok: true });
      } else if (ev?.type === "hook:error") {
        resolved = true;
        process.off("SIGTERM", onTerm);
        resolve({ ok: false, reason: "hook:error" });
      }
    });
    ws.on("error", (err: Error) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, reason: err.message });
    });
    ws.on("close", () => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, reason: "ws closed before turnEnd" });
    });
  });

  // POST /emit after the WS is subscribed and authed (connectGatewayWs
  // resolves after auth_ok).
  const { status, data } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/emit`,
    {
      event: {
        source: "user",
        type: "user_input",
        to: agentId,
        payload: { content },
        handoff: "turn",
      },
    },
  );
  if (status >= 400) {
    try { ws.close(); } catch { /* ignore */ }
    die(JSON.stringify(data));
  }

  const result = await turnEnded;
  try { ws.close(); } catch { /* ignore */ }
  if (!result.ok) {
    process.stderr.write(`[stream-json] turn did not end normally: ${result.reason ?? "unknown"}\n`);
    process.exit(1);
  }
}
