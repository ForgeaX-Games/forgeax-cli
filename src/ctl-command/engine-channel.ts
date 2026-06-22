#!/usr/bin/env node
/**
 * @desc Engine Runtime subscriber — lightweight bridge between Gateway and a running engine process.
 *
 * Thin adapter that forwards Gateway events to a local engine HTTP endpoint.
 * The engine process exposes a small HTTP server on a known port (default:
 * 3710) that this bridge posts events to.
 *
 * WS lifecycle (connect / reconnect) is inlined here so the subscriber fully
 * owns it — no shared "channel helper" abstraction. This is the simplest of
 * the three subscribers (no instanceId switching, no emit, no inbound loop):
 * a good reference for "how to write a minimal Gateway client".
 *
 * Usage:
 *   pnpm engine-channel [instanceId]
 */

import type WebSocket from "ws";
import { resolveStateDir } from "../fs/state-dir.js";
import {
  loadConnInfo, connectGatewayWs, resolveInstanceId,
  type ConnInfo,
} from "../channels/shared/gateway-conn.js";

const stateDir = resolveStateDir();

const DEFAULT_ENGINE_PORT = 3710;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] [engine-channel] ${msg}\n`);
}

class EngineRuntimeSubscriber {
  private readonly conn: ConnInfo;
  private readonly enginePort: number;
  private readonly engineHost: string;
  private readonly instanceId: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;

  private static readonly BASE_DELAY_MS = 2_000;
  private static readonly MAX_DELAY_MS = 30_000;

  constructor(opts: { instanceId: string; enginePort?: number; engineHost?: string }) {
    this.instanceId = opts.instanceId;
    this.enginePort = opts.enginePort ?? DEFAULT_ENGINE_PORT;
    this.engineHost = opts.engineHost ?? "127.0.0.1";
    this.conn = loadConnInfo(stateDir);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  /** Connect WS → install message + close handlers → log readiness. */
  private async connect(): Promise<void> {
    const newWs = await connectGatewayWs(this.conn);
    this.ws = newWs;
    this.reconnectAttempt = 0;

    // Event loop: filter by instanceId, forward to engine HTTP endpoint.
    newWs.on("message", (raw: Buffer) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }
      if (frame.type !== "event" || frame.instanceId !== this.instanceId || !frame.event) return;
      const url = `http://${this.engineHost}:${this.enginePort}/_ai/event`;
      const body = JSON.stringify({ event: frame.event, emitterId: frame.emitterId });
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {
        // Engine may not be listening yet or temporarily unavailable — non-fatal.
      });
    });

    // Close handler: reconnect unless intentionally stopped.
    newWs.on("close", (code: number) => {
      if (this.stopped || code === 1000 || code === 4001) return;
      void this.reconnect();
    });

    log(`Bridge ready — forwarding events to engine at ${this.engineHost}:${this.enginePort}`);
  }

  /** Exponential-backoff reconnect (2s → 30s cap). Stops on `stopped` flag. */
  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    this.reconnectAttempt++;
    const delay = Math.min(
      EngineRuntimeSubscriber.BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1),
      EngineRuntimeSubscriber.MAX_DELAY_MS,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (err) {
      process.stderr.write(`[engine-channel] reconnect failed: ${(err as Error)?.message ?? String(err)}\n`);
      void this.reconnect();
    }
  }

  async stop(): Promise<void> {
    log("Bridge shutting down");
    this.stopped = true;
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }
}

// ─── Entrypoint ───

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => a !== "--");

  const { getSharedPaths } = await import("../fs/state-dir.js");
  getSharedPaths(stateDir);

  let instanceId = process.env.MC_TARGET_INSTANCE;
  if (!instanceId && args[0] && !args[0].startsWith("-")) {
    instanceId = args[0];
  }
  if (!instanceId) {
    let conn: ConnInfo;
    try { conn = loadConnInfo(stateDir); } catch (err: unknown) {
      process.stderr.write(`Cannot read gateway.json: ${(err as Error).message}\nIs the Gateway running?\n`);
      process.exit(1);
    }
    const resolved = await resolveInstanceId(conn);
    if (resolved.instanceId === null) {
      process.stderr.write(`${resolved.reason}\n`);
      process.exit(1);
    }
    instanceId = resolved.instanceId;
  }
  if (!instanceId) {
    process.stderr.write("No instanceId specified. Use MC_TARGET_INSTANCE env or pass as CLI arg.\n");
    process.exit(1);
  }

  const enginePort = process.env.ENGINE_BRIDGE_PORT
    ? parseInt(process.env.ENGINE_BRIDGE_PORT, 10)
    : DEFAULT_ENGINE_PORT;

  const sub = new EngineRuntimeSubscriber({
    instanceId,
    enginePort,
  });

  process.on("SIGINT", () => {
    sub.stop().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    sub.stop().then(() => process.exit(0));
  });

  await sub.start();

  // Keep the process alive (subscriber owns the WS connection)
  await new Promise<void>(() => { /* never resolves */ });
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
