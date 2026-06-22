/** @desc AgenTeam-OS 入口 — daemon launcher + gateway runner */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { openSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { resolveStateDir } from "./fs/state-dir.js";

const stateDir = resolveStateDir();
mkdirSync(stateDir, { recursive: true });

const pidFile = join(stateDir, "gateway.pid");
const logFile = join(stateDir, "gateway.log");

// ─── Foreground mode: --fg flag or FORGEAX_FG=1 ───
const foreground = process.argv.includes("--fg") || process.env.FORGEAX_FG === "1";

if (!foreground) {
  // ── Launcher: fork daemon and exit ──
  launchDaemon();
} else {
  // ── Daemon: actually run the Gateway ──
  runGateway();
}

function launchDaemon(): void {
  // Check if already running via PID file
  if (existsSync(pidFile)) {
    const oldPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (oldPid && isProcessAlive(oldPid)) {
      process.stdout.write(`Gateway already running (pid ${oldPid}). Use: pnpm ctl shutdown\n`);
      process.exit(0);
    }
    unlinkSync(pidFile);
  }

  // Also check if something is already listening on the configured port
  const port = readConfigPort();
  isPortInUse(port).then((inUse) => {
    if (inUse) {
      process.stdout.write(`Port ${port} is already in use. A Gateway may still be shutting down — retry shortly.\n`);
      process.exit(1);
    }
    forkDaemon(port);
  });
}

function forkDaemon(preCheckPort: number): void {
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [...process.execArgv, ...getScriptArgs(), "--fg"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, FORGEAX_FG: "1" },
  });

  child.unref();
  const pid = child.pid!;
  writeFileSync(pidFile, String(pid) + "\n");

  process.stdout.write("╔════════════════════════════════╗\n");
  process.stdout.write("║        ForgeaX CLI v1.3.0         ║\n");
  process.stdout.write("╚════════════════════════════════╝\n\n");
  process.stdout.write(`Starting Gateway daemon (pid ${pid})...`);

  const TIMEOUT_MS = 60_000;
  const POLL_MS = 300;
  const deadline = Date.now() + TIMEOUT_MS;

  const poll = () => {
    if (!isProcessAlive(pid)) {
      process.stdout.write(" FAILED\n");
      process.stderr.write(`Gateway process exited unexpectedly. Check log: ${logFile}\n`);
      process.exit(1);
      return;
    }
    const port = readConfigPort() || preCheckPort;
    isPortInUse(port).then((listening) => {
      if (listening) {
        process.stdout.write(" ready\n\n");
        process.stdout.write(`Gateway running on http://127.0.0.1:${port} (pid ${pid})\n`);
        process.stdout.write(`Log: ${logFile}\n`);
        process.stdout.write(`Stop: pnpm ctl shutdown\n`);
        process.stdout.write(`Instances are booting in background — check status: pnpm ctl status\n\n`);
        process.exit(0);
      } else if (Date.now() >= deadline) {
        process.stdout.write(" TIMEOUT\n");
        process.stderr.write(`Gateway did not become ready within ${TIMEOUT_MS / 1000}s. Check log: ${logFile}\n`);
        process.exit(1);
      } else {
        process.stdout.write(".");
        setTimeout(poll, POLL_MS);
      }
    });
  };

  setTimeout(poll, POLL_MS);
}

function getScriptArgs(): string[] {
  const args = process.argv.slice(1).filter(a => a !== "--fg");
  return args;
}

function readConfigPort(): number {
  try {
    const raw = readFileSync(join(stateDir, "gateway.json"), "utf-8");
    return JSON.parse(raw).port ?? 3700;
  } catch { return 3700; }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { resolve(false); });
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── Daemon entry point ───

function runGateway(): void {
  register(new URL("./fs/hot-module-hooks.js", import.meta.url).href);
  import("./core/logger.js").then(({ installConsoleBridge }) => {
    installConsoleBridge();
    startGateway();
  });
}

/**
 * Append one structured fault record to <stateDir>/fatal.jsonl. Best-effort:
 * never throws (a logging failure must not become the thing that kills the
 * daemon). Mirrors the worker's "log, don't self-destruct" stance.
 */
function logFault(kind: string, err: unknown, extra?: Record<string, unknown>): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    const rec = JSON.stringify({ ts: Date.now(), level: "fatal", kind, message: msg, ...extra }) + "\n";
    appendFileSync(join(stateDir, "fatal.jsonl"), rec, "utf-8");
  } catch { /* logging must never escalate */ }
  try { process.stderr.write(`[FAULT:${kind}] ${msg}\n`); } catch {}
}

async function startGateway(): Promise<void> {
  let gateway: import("./gateway/gateway.js").Gateway | null = null;
  // Startup-phase vs runtime-phase boundary. During startup an uncaught error
  // is genuinely fatal (the daemon never came up) → exit. Once the gateway is
  // serving, a single unhandled rejection / uncaught exception MUST NOT take
  // down the whole 18900 backend (that connects-by-death every session). We
  // log it and keep running — aligned with the worker child's policy in
  // instance-worker.ts (uncaught → console.error + continue; unhandled →
  // console.error only). Only an explicit fatal signal triggers shutdown.
  let started = false;

  process.on("uncaughtException", (err) => {
    if (!started) {
      // Startup phase: the daemon is not yet usable — fail loudly and exit so
      // the launcher's poll() reports FAILED instead of a half-dead gateway.
      logFault("uncaughtException.startup", err);
      cleanupPid();
      setTimeout(() => process.exit(1), 200);
      return;
    }
    // Runtime phase: record and keep serving. One bad async path (e.g. a stub
    // getter throw, an SSE body! assert) must not connect-by-death all sessions.
    logFault("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    if (!started) {
      logFault("unhandledRejection.startup", reason);
      cleanupPid();
      setTimeout(() => process.exit(1), 200);
      return;
    }
    // Never exit on a runtime rejection — this was the single point that wiped
    // the entire backend ("用着用着整个后端没了").
    logFault("unhandledRejection", reason);
  });

  try {
    await import("./llm/register-all.js");

    const { Gateway } = await import("./gateway/gateway.js");
    const { loadGatewayConfig } = await import("./gateway/config.js");
    const { GatewayServer } = await import("./gateway/server/gateway-server.js");
    const { ensureSharedConfigs } = await import("./defaults/index.js");

    await ensureSharedConfigs(stateDir);
    const config = loadGatewayConfig(stateDir);
    gateway = new Gateway(config, stateDir);

    const { discoverInstances } = await import("./gateway/instance-registry.js");
    const discovered = discoverInstances(stateDir);
    const enabledInstances = discovered.filter(d => d.meta.autoStart);

    if (enabledInstances.length === 0) {
      console.log("No enabled instances found — Gateway idle. Use CLI to create one.");
    }
    for (const inst of enabledInstances) {
      await gateway.addInstance(inst.id);
    }

    gateway.attachServer(new GatewayServer({
      token: config.token,
      host: config.host,
      port: config.port,
    }));

    await gateway.start();
    // Past this point the daemon is serving: switch the fault boundary from
    // "startup-fatal-exit" to "runtime-log-and-continue".
    started = true;

    // Flush async ledger writers (see session/async-ledger-writer) and shut the
    // gateway down cleanly on a real termination signal, so buffered events are
    // not lost on exit.
    const onTerm = async (sig: string) => {
      logFault(`signal.${sig}`, new Error(`received ${sig}`));
      try { const { flushAllLedgerWriters } = await import("./session/async-ledger-writer.js"); await flushAllLedgerWriters(); } catch {}
      if (gateway) { try { await gateway.shutdown(); } catch {} }
      cleanupPid();
      process.exit(0);
    };
    process.once("SIGTERM", () => { void onTerm("SIGTERM"); });
    process.once("SIGINT", () => { void onTerm("SIGINT"); });

    const instanceIds = enabledInstances.map(i => i.id).join(", ") || "(none)";
    console.log(`Gateway running — http://${config.host}:${config.port} — instances: ${instanceIds}`);
  } catch (err) {
    console.error("启动失败:", err);
    cleanupPid();
    setTimeout(() => process.exit(1), 200);
  }
}

function cleanupPid(): void {
  try { unlinkSync(pidFile); } catch {}
}
