/**
 * @desc Gateway protocol client utilities — HTTP/WS helpers and instance auto-discovery.
 *
 *       Used by any code that talks to the Gateway HTTP+WS surface:
 *       - gateway-ctl (admin CLI)
 *       - subscribers in src/ctl-command/ (ink-renderer, wechat, engine-channel)
 *       - third-party tooling that wants to consume the public protocol
 *
 *       This file deliberately stays a thin protocol layer — no event loop
 *       abstraction, no auto-reconnect helper. Each subscriber owns its own
 *       WS lifecycle (connect / event filter / reconnect). See engine-channel.ts
 *       for the simplest reference implementation.
 *
 *       Historical: `fetchDefaultAgent` helper was removed in MR !326.
 *       Consumers now call `fetch_default_agent` via the commands transport
 *       (see `commands/agent-state.ts`).
 */

import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTANCE_STATUS_PENDING, INSTANCE_STATUS_TERMINAL, PROVISIONING_PHASE_LABEL } from "../../core/types.js";
import type { ProvisioningPhase } from "../../core/types.js";

// ─── Types ───

export interface ConnInfo {
  token: string;
  host: string;
  port: number;
}

export interface InstanceInfo {
  id: string;
  status: import("../../core/types.js").InstanceStatus;
  statusMessage?: string;
  provisioningPhase?: import("../../core/types.js").ProvisioningPhase;
}

export type ResolveResult =
  | { instanceId: string; note?: string }
  | { instanceId: null; reason: string };

// ─── Config ───

export function loadConnInfo(stateDir: string): ConnInfo {
  const raw = readFileSync(join(stateDir, "gateway.json"), "utf-8");
  const cfg = JSON.parse(raw);
  return {
    token: cfg.token ?? "",
    host: cfg.host ?? "127.0.0.1",
    port: cfg.port ?? 3700,
  };
}

// ─── HTTP helper ───

export function apiCall(
  conn: ConnInfo,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (conn.token) headers["Authorization"] = `Bearer ${conn.token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest(
      { hostname: conn.host, port: conn.port, path, method, headers, timeout: opts?.timeoutMs ?? 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: unknown;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error("Request timed out")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Instance discovery ───

export async function listInstances(conn: ConnInfo): Promise<InstanceInfo[]> {
  const { status, data } = await apiCall(conn, "GET", "/api/instances");
  if (status !== 200) return [];
  const arr = (data as Record<string, unknown>).instances;
  if (!Array.isArray(arr)) return [];
  return arr as InstanceInfo[];
}

const STATUS_NOTE: Record<string, string> = {
  idle: "空闲中 (无 team)",
  provisioning: "正在初始化基础设施...",
  starting: "正在启动 agents...",
  stopping: "正在停止...",
  stopped: "已停止",
  restarting: "正在重启...",
  error: "初始化失败",
  unloaded: "未加载",
};

function instanceStatusNote(inst: InstanceInfo): string {
  if (inst.status === "provisioning" && inst.provisioningPhase) {
    return PROVISIONING_PHASE_LABEL[inst.provisioningPhase as ProvisioningPhase] ?? STATUS_NOTE.provisioning;
  }
  return STATUS_NOTE[inst.status] ?? `状态: ${inst.status}`;
}

/**
 * Resolve which instanceId to use:
 *  1. preferred exists in list → use it (warn if not running)
 *  2. preferred missing / not given → pick first running
 *  3. no running → pick first idle|starting
 *  4. nothing at all → null
 */
export async function resolveInstanceId(
  conn: ConnInfo,
  preferred?: string,
): Promise<ResolveResult> {
  const all = await listInstances(conn);

  if (all.length === 0) {
    return { instanceId: null, reason: "Gateway 中没有可用实例" };
  }

  // 1. User explicitly specified an instance
  if (preferred) {
    const match = all.find(i => i.id === preferred);
    if (match) {
      const note = match.status === "running"
        ? undefined
        : `实例 "${match.id}" ${instanceStatusNote(match)}`;
      return { instanceId: match.id, note };
    }
    // preferred not found — fall through to auto-select, but remember to warn
  }

  // 2. First running instance
  const running = all.find(i => i.status === "running");
  if (running) {
    const note = preferred
      ? `指定的实例 "${preferred}" 不存在，自动切换到 "${running.id}" (running)`
      : undefined;
    return { instanceId: running.id, note };
  }

  // 3. First pending (provisioning/starting/idle) instance
  const pending = all.find(i => INSTANCE_STATUS_PENDING.has(i.status));
  if (pending) {
    let note = `实例 "${pending.id}" ${instanceStatusNote(pending)}`;
    if (preferred) {
      note = `指定的实例 "${preferred}" 不存在，自动切换到 "${pending.id}" — ${instanceStatusNote(pending)}`;
    }
    return { instanceId: pending.id, note };
  }

  // 4. All instances are stopped/error
  const ids = all.map(i => `${i.id}(${i.status})`).join(", ");
  return { instanceId: null, reason: `所有实例均不可用: ${ids}` };
}

/**
 * Wait for a specific instance to reach "running" status.
 * Polls /api/instances every `intervalMs` up to `timeoutMs`.
 * Calls `onProgress` with status updates for user feedback.
 */
export async function waitForInstanceReady(
  conn: ConnInfo,
  instanceId: string,
  opts?: {
    timeoutMs?: number;
    intervalMs?: number;
    onProgress?: (status: string, elapsed: number) => void;
  },
): Promise<{ ready: boolean; finalStatus: string }> {
  const timeout = opts?.timeoutMs ?? 120_000;
  const interval = opts?.intervalMs ?? 2_000;
  const onProgress = opts?.onProgress;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const all = await listInstances(conn).catch(() => [] as InstanceInfo[]);
    const inst = all.find(i => i.id === instanceId);
    if (!inst) return { ready: false, finalStatus: "not_found" };
    if (inst.status === "running") return { ready: true, finalStatus: "running" };
    if (INSTANCE_STATUS_TERMINAL.has(inst.status)) {
      return { ready: false, finalStatus: inst.status };
    }
    onProgress?.(inst.status, Date.now() - start);
    await new Promise(r => setTimeout(r, interval));
  }
  return { ready: false, finalStatus: "timeout" };
}

// ─── WebSocket handshake ───

/** Plain auth — no channel registration. Used by gateway-ctl and other non-channel tools. */
export async function connectGatewayWs(conn: ConnInfo): Promise<import("ws").default> {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://${conn.host}:${conn.port}/ws`);

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      // server auto-sends auth_ok in no-token mode — sending an `auth` frame
      // here would trigger a harmless but noisy "Already authenticated" error.
      if (conn.token) ws.send(JSON.stringify({ type: "auth", token: conn.token }));
    });
    ws.on("message", (raw: Buffer) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }
      if (frame.type === "auth_ok") { resolve(); return; }
      if (frame.type === "error") { reject(new Error(String(frame.message))); return; }
    });
    ws.on("error", reject);
  });

  return ws;
}

