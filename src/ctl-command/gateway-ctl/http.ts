/** @desc Shared HTTP client & CLI helpers for gateway-ctl sub-commands */

import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../../fs/state-dir.js";

// ─── Config ───

export interface ConnInfo {
  token: string;
  host: string;
  port: number;
}

export function loadConnInfo(): ConnInfo {
  const stateDir = resolveStateDir();
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
      { hostname: conn.host, port: conn.port, path, method, headers },
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
    req.on("error", (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Output ───

export function print(data: unknown): void {
  if (typeof data === "string") {
    process.stdout.write(data + "\n");
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

export function die(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  process.stdout.write(line(headers) + "\n");
  process.stdout.write(widths.map(w => "─".repeat(w)).join("──") + "\n");
  for (const row of rows) process.stdout.write(line(row) + "\n");
}

// ─── Arg parsing ───

export function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val;
}
