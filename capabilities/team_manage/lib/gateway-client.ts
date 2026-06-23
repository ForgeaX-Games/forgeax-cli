// @desc Minimal HTTP client for admin tools to call the Gateway API
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { getSharedPaths } from "#src/fs/state-dir.js";
import type { AgentContext } from "#src/core/types.js";

interface ConnInfo {
  token: string;
  host: string;
  port: number;
}

function loadConnInfo(): ConnInfo {
  // gateway.json lives at host-level ~/.agenteam/gateway.json — outside instance root.
  // Use node:fs directly: fs-bridge would route this through `docker exec` when sandbox is
  // enabled (path is outside instance bind-mount), and the container has no such file →
  // readTextSync throws → caught here → empty token → Gateway returns 401.
  // capability code runs in the Instance Worker (host process), so node:fs is correct here.
  try {
    const raw = readFileSync(getSharedPaths().gatewayConfig(), "utf-8");
    const cfg = JSON.parse(raw);
    return {
      token: cfg.token ?? "",
      host: cfg.host ?? "127.0.0.1",
      port: cfg.port ?? 3700,
    };
  } catch {
    return { token: "", host: "127.0.0.1", port: 3700 };
  }
}

/** Instance id derived from `pathManager.instance().root()` basename. */
export function getInstanceId(ctx: AgentContext): string {
  return basename(ctx.pathManager.instance().root());
}

/** Read current pack id from team/manifest.json (the runtime pack tracker). */
export function getCurrentPackId(ctx: AgentContext): string | null {
  try {
    const manifestPath = join(ctx.pathManager.team().root(), "manifest.json");
    const m = JSON.parse(getSandboxFs().readTextSync(manifestPath));
    return typeof m?.id === "string" ? m.id : null;
  } catch {
    return null;
  }
}

/** Call a Gateway HTTP endpoint and return {status, data}. */
export async function gatewayApi(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const conn = loadConnInfo();
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (conn.token) headers["Authorization"] = `Bearer ${conn.token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest(
      { hostname: conn.host, port: conn.port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: any;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Format Gateway API result as a readable string for tool output. */
export function formatApiResult(label: string, result: { status: number; data: any }): string {
  if (result.status >= 400) {
    return `${label} failed (HTTP ${result.status}): ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}`;
  }
  return `${label} OK (HTTP ${result.status}):\n${typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2)}`;
}
