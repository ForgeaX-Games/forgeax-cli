/** @desc CLI — gateway control commands (status, shutdown, restart) */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveStateDir } from "../../fs/state-dir.js";
import { type ConnInfo, apiCall, print } from "./http.js";

export async function cmdStatus(conn: ConnInfo): Promise<void> {
  const { data } = await apiCall(conn, "GET", "/health");
  print(data);
}

async function waitForProcessExit(timeoutMs: number): Promise<void> {
  const pidFile = join(resolveStateDir(), "gateway.pid");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(pidFile)) return;
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

export async function cmdShutdown(conn: ConnInfo): Promise<void> {
  const { data } = await apiCall(conn, "POST", "/api/shutdown");
  print(data);

  process.stdout.write("Waiting for Gateway to stop...");
  await waitForProcessExit(15_000);
  process.stdout.write(" done\n");
}

export async function cmdRestart(conn: ConnInfo): Promise<void> {
  try {
    await apiCall(conn, "POST", "/api/shutdown");
  } catch { /* may already be down */ }

  await waitForProcessExit(10_000);

  process.stdout.write("Restarting Gateway...\n");
  const mainScript = join(new URL(".", import.meta.url).pathname, "..", "..", "main.ts");
  const child = spawn(process.execPath, [...process.execArgv, mainScript], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });
  child.unref();

  await new Promise(r => setTimeout(r, 1500));
  try {
    const { data } = await apiCall(conn, "GET", "/health");
    print(data);
  } catch {
    process.stdout.write("Gateway started (status check pending — try: pnpm ctl status)\n");
  }
}
