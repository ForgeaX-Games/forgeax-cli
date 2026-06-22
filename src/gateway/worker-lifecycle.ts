/** @desc Worker Lifecycle — pid file management and orphan cleanup */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, existsSync } from "node:fs";

function workersDir(stateDir: string): string {
  return join(stateDir, "workers");
}

function pidPath(stateDir: string, instanceId: string): string {
  return join(workersDir(stateDir), `${instanceId}.pid`);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function writeWorkerPid(stateDir: string, instanceId: string, pid: number): void {
  const dir = workersDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidPath(stateDir, instanceId), String(pid) + "\n");
}

export function removeWorkerPid(stateDir: string, instanceId: string): void {
  try { unlinkSync(pidPath(stateDir, instanceId)); } catch {}
}

/**
 * Kill orphaned workers from a previous gateway session and stop their
 * Docker containers so ports are properly freed.
 */
export function cleanupOrphanWorkers(stateDir: string): void {
  const dir = workersDir(stateDir);
  if (!existsSync(dir)) return;

  let files: string[];
  try { files = readdirSync(dir); } catch { return; }

  for (const f of files) {
    if (!f.endsWith(".pid")) continue;
    const filePath = join(dir, f);
    const instId = f.replace(/\.pid$/, "");
    let pid: number;
    try {
      pid = parseInt(readFileSync(filePath, "utf-8").trim(), 10);
    } catch { try { unlinkSync(filePath); } catch {} continue; }

    if (!pid || !Number.isFinite(pid)) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }

    stopOrphanContainers(stateDir, instId);

    if (isProcessAlive(pid)) {
      console.log(`[Gateway] Killing orphan worker for "${instId}" (pid ${pid})`);
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    try { unlinkSync(filePath); } catch {}
  }

  // Sweep socat forwarders orphaned by workers that crashed or were already dead
  try { execSync(`pkill -9 -f 'socat TCP-LISTEN'`, { timeout: 3000, stdio: "ignore" }); } catch {}
}

function stopOrphanContainers(stateDir: string, instanceId: string): void {
  const listPath = join(stateDir, "instances", instanceId, "containers.list");
  if (!existsSync(listPath)) return;
  let names: string[];
  try {
    names = readFileSync(listPath, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
  } catch { return; }

  for (const name of names) {
    try {
      console.log(`[Gateway] Stopping orphan container "${name}" for instance "${instanceId}"`);
      execSync(`docker stop ${name}`, { timeout: 10_000, stdio: "ignore" });
    } catch {}
  }
}
