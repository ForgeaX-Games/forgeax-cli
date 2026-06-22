#!/usr/bin/env node
/**
 * @desc WeChat subscriber — bridges WeChat (via iLink long-poll) to Gateway via plain WS.
 *
 * Instance selection: MC_TARGET_INSTANCE env var or CLI arg.
 * Agent selection stays internal (cache → defaultAgent → first).
 * QR code is printed to stdout (and the per-line log) for the user to scan.
 *
 * WS lifecycle (connect / reconnect / abort) is inlined here so the subscriber
 * fully owns it — no shared "channel helper" abstraction. WeChat outbound is
 * handled by `setupOutboundListener` which subscribes to ws frames inside the
 * monitor module; the inbound loop is started fire-and-forget here and aborted
 * via `abortController` on WS close / shutdown.
 */

import type WebSocket from "ws";
import { resolveStateDir, getSharedPaths } from "../fs/state-dir.js";
import { loadAccount, saveAccount, loadChannelConfig, saveChannelConfig } from "../channels/wechat/wechat-store.js";
import { startLogin, waitForLogin, DEFAULT_BASE_URL } from "../channels/wechat/wechat-auth.js";
import { runInboundLoop, setupOutboundListener } from "../channels/wechat/wechat-monitor.js";
import type { MonitorOpts } from "../channels/wechat/wechat-monitor.js";
import {
  loadConnInfo, apiCall, resolveInstanceId, connectGatewayWs,
  type ConnInfo,
} from "../channels/shared/gateway-conn.js";

const stateDir = resolveStateDir();

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] [wechat] ${msg}\n`);
}

// ─── WeChat subscriber ───

class WeChatSubscriber {
  private abortController = new AbortController();
  private readonly forceLogin: boolean;
  private readonly instanceId: string;
  private readonly conn: ConnInfo;
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private sigintAttached = false;

  private static readonly BASE_DELAY_MS = 2_000;
  private static readonly MAX_DELAY_MS = 30_000;

  constructor(opts: { instanceId: string; forceLogin: boolean }) {
    this.instanceId = opts.instanceId;
    this.forceLogin = opts.forceLogin;
    this.conn = loadConnInfo(stateDir);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  /** Connect WS → install close handler → run business init (onReady). */
  private async connect(): Promise<void> {
    const newWs = await connectGatewayWs(this.conn);
    this.ws = newWs;
    this.reconnectAttempt = 0;

    // Close handler: abort the inbound loop attached to the dying WS, then
    // reconnect unless intentionally stopped. (We do NOT install a `message`
    // listener here — setupOutboundListener inside the monitor module owns
    // that, since WeChat's outbound path needs the ws directly.)
    newWs.on("close", (code: number) => {
      if (this.stopped || code === 1000 || code === 4001) return;
      this.abortController.abort();
      void this.reconnect();
    });

    // Business init — login + agentId resolve + monitor setup + start inbound
    // loop. Failures throw, propagating to start()'s caller (main().catch()).
    await this.onReady(newWs);
  }

  /** Exponential-backoff reconnect (2s → 30s cap). Stops on `stopped` flag. */
  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    this.reconnectAttempt++;
    const delay = Math.min(
      WeChatSubscriber.BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1),
      WeChatSubscriber.MAX_DELAY_MS,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (err) {
      process.stderr.write(`[wechat] reconnect failed: ${(err as Error)?.message ?? String(err)}\n`);
      void this.reconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController.abort();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  private async onReady(ws: WebSocket): Promise<void> {
    const instId = this.instanceId;
    const conn = this.conn;

    // ─── WeChat login ───

    let account = loadAccount();

    if (!account || this.forceLogin) {
      const apiBaseUrl = account?.baseUrl ?? DEFAULT_BASE_URL;
      const { qrcode } = await startLogin(apiBaseUrl, (msg) => log(msg));

      log(`扫码登录: ${qrcode}`);
      log("(QR 码 URL 已打印到 stdout，请扫码后等待登录完成。8 分钟内有效。)");

      const result = await waitForLogin({
        qrcode,
        apiBaseUrl,
        log: (msg) => log(msg),
      });

      if (!result.connected || !result.botToken || !result.botId) {
        log(`登录失败/过期: ${result.message}`);
        process.stderr.write(`${result.message}\n`);
        process.exit(1);
      }

      account = {
        token: result.botToken,
        baseUrl: result.baseUrl ?? DEFAULT_BASE_URL,
        botId: result.botId,
        userId: result.userId,
        savedAt: new Date().toISOString(),
      };
      saveAccount(account);
      log(`登录成功, botId=${account.botId}`);
    } else {
      log(`已使用缓存 token，botId=${account.botId}`);
    }

    // ─── Resolve agentId (stays in subscriber, not Gateway) ───

    const channelCfg = loadChannelConfig();
    let agentId = channelCfg.agentId;

    let agents: string[] = [];
    try {
      const { data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instId)}/commands/list_agents/query`, { args: [] });
      const r = (data as { result?: { ok?: boolean; data?: unknown } })?.result;
      if (r?.ok) agents = ((r.data as Array<{ id: string }>) ?? []).map((n) => n.id);
    } catch {
      log("查询 agent 列表失败");
    }

    if (agentId && !agents.includes(agentId)) {
      log(`缓存的 agent "${agentId}" 在当前 team 中不存在（team 已切换？），重新选择...`);
      agentId = undefined;
    }

    if (!agentId) {
      let defaultAgent: string | null = null;
      try {
        const { data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instId)}/commands/fetch_default_agent/query`, { args: [] });
        const r = (data as { result?: { ok?: boolean; data?: unknown } })?.result;
        if (r?.ok && typeof r.data === "string") defaultAgent = r.data;
      } catch { /* fall through to picker */ }
      if (defaultAgent && agents.includes(defaultAgent)) {
        agentId = defaultAgent;
        saveChannelConfig({ agentId });
        log(`使用 team 默认 agent "${agentId}" (已保存到 channel.json)`);
      } else if (agents.length) {
        agentId = agents[0];
        saveChannelConfig({ agentId });
        log(`自动选择 agent "${agentId}" (已保存到 channel.json)`);
      } else {
        log("该实例暂无可用 agent，消息将发送到实例但可能无人处理");
      }
    } else {
      log(`使用配置的 agent "${agentId}"`);
    }

    // ─── Start monitor ───

    // Fresh AbortController for this (re)connect cycle — close handler aborts
    // the previous one before triggering reconnect, so this is always a new one.
    this.abortController = new AbortController();

    const monitorOpts: MonitorOpts = {
      baseUrl: account.baseUrl,
      token: account.token,
      ws,
      instanceId: instId,
      agentId,
      log: (msg: string) => log(msg),
      abortSignal: this.abortController.signal,
    };

    setupOutboundListener(monitorOpts);
    log("WeChat monitor started");

    // ─── SIGINT handling (idempotent — onReady fires on every reconnect) ───

    if (!this.sigintAttached) {
      process.on("SIGINT", () => {
        log("shutting down...");
        this.stop().then(() => {
          setTimeout(() => process.exit(0), 500);
        });
      });
      this.sigintAttached = true;
    }

    // Start the inbound long-running loop fire-and-forget — onReady must
    // return promptly so connect() can install the close handler chain and
    // start()'s caller gets control back. The loop is aborted on WS close
    // (close handler → abortController.abort()) and on shutdown (stop()).
    const signal = this.abortController.signal;
    void runInboundLoop(monitorOpts).catch((err) => {
      if (signal.aborted) return;
      log(`inbound loop error: ${(err as Error)?.message ?? String(err)}`);
    });
  }
}

// ─── Entrypoint ───

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => a !== "--");
  const forceLogin = args.includes("--login");
  const positional = args.filter(a => !a.startsWith("--"));

  getSharedPaths(stateDir);

  // Resolve instanceId: env var → CLI arg → auto-discover
  let instanceId = process.env.MC_TARGET_INSTANCE;
  if (!instanceId && positional[0]) {
    instanceId = positional[0];
  }
  if (!instanceId) {
    let conn: ConnInfo;
    try { conn = loadConnInfo(stateDir); } catch (err: any) {
      process.stderr.write(`Cannot read gateway.json: ${err.message}\nIs the Gateway running?\n`);
      process.exit(1);
    }
    const resolved = await resolveInstanceId(conn);
    if (resolved.instanceId === null) {
      process.stderr.write(`${resolved.reason}\n请先通过 Gateway 创建并启动一个实例。\n`);
      process.exit(1);
    }
    instanceId = resolved.instanceId;
    if (resolved.note) process.stdout.write(`${resolved.note}\n`);
  }
  if (!instanceId) {
    process.stderr.write("No instanceId specified. Use MC_TARGET_INSTANCE env or pass as CLI arg.\n");
    process.exit(1);
  }

  const sub = new WeChatSubscriber({
    instanceId,
    forceLogin,
  });

  await sub.start();

  // Keep the process alive — start() returns once the WS is connected + the
  // close handler / inbound loop are wired up; the WS + inbound loop continue
  // in the background. Exit goes via the SIGINT handler installed in onReady.
  await new Promise<void>(() => { /* never resolves */ });
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
