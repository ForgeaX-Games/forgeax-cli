// @desc Socat-based dynamic port forwarding for bridge-mode containers

import { spawn, execSync, type ChildProcess } from "node:child_process";

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  protocol: "tcp";
}

interface SocatEntry {
  mapping: PortMapping;
  proc: ChildProcess;
  restartTimer?: ReturnType<typeof setTimeout>;
  backoff: number;
}

function runDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker ${args[0]} failed (code ${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

function mappingKey(m: PortMapping): string {
  return `${m.hostPort}:${m.containerPort}`;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export class PortForwarder {
  private readonly entries = new Map<string, SocatEntry>();
  private containerIP: string | null = null;
  private stopped = false;
  private readonly _exitHandler: () => void;

  constructor(private readonly containerName: string) {
    // Guarantee socat cleanup on ANY worker exit (SIGTERM, crash, normal exit).
    // process 'exit' handler runs synchronously — process.kill() is sync, so this works.
    this._exitHandler = () => this._killAllSync();
    process.on("exit", this._exitHandler);
  }

  async syncForwards(desired: PortMapping[]): Promise<void> {
    this.stopped = false;
    this.containerIP = await this.resolveContainerIP();

    const desiredKeys = new Set(desired.map(mappingKey));
    const currentKeys = new Set(this.entries.keys());

    for (const key of currentKeys) {
      if (!desiredKeys.has(key)) {
        this.killEntry(key);
      }
    }

    for (const m of desired) {
      const key = mappingKey(m);
      if (!currentKeys.has(key)) {
        this.spawnSocat(m);
      }
    }
  }

  stopAll(): void {
    this.stopped = true;
    this._killAllSync();
    try { process.removeListener("exit", this._exitHandler); } catch {}
  }

  private _killAllSync(): void {
    for (const [, entry] of this.entries) {
      if (entry.restartTimer) clearTimeout(entry.restartTimer);
      try { entry.proc.kill("SIGKILL"); } catch {}
    }
    this.entries.clear();
    this.containerIP = null;
  }

  private killEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    try { entry.proc.kill("SIGKILL"); } catch {}
    this.entries.delete(key);
  }

  private spawnSocat(m: PortMapping): void {
    if (!this.containerIP) return;

    // Clean up any stale process occupying the host port (e.g. orphaned socat from crashed worker)
    try { execSync(`fuser -k ${m.hostPort}/tcp`, { stdio: "ignore", timeout: 3000 }); } catch {}

    const key = mappingKey(m);
    const proc = spawn("socat", [
      `TCP-LISTEN:${m.hostPort},fork,reuseaddr`,
      `TCP:${this.containerIP}:${m.containerPort}`,
    ], { stdio: "ignore" });

    const entry: SocatEntry = { mapping: m, proc, backoff: BASE_BACKOFF_MS };
    this.entries.set(key, entry);

    proc.on("exit", (code) => {
      if (this.stopped || !this.entries.has(key)) return;
      console.warn(`[PortForwarder] socat ${key} exited (code ${code}), respawning in ${entry.backoff}ms`);
      entry.restartTimer = setTimeout(() => {
        if (this.stopped || !this.entries.has(key)) return;
        this.entries.delete(key);
        entry.backoff = Math.min(entry.backoff * 2, MAX_BACKOFF_MS);
        this.spawnSocat(m);
        const newEntry = this.entries.get(key);
        if (newEntry) newEntry.backoff = entry.backoff;
      }, entry.backoff);
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      this.entries.delete(key);
      if (err.code === "ENOENT") {
        console.error(`[PortForwarder] socat not found — port forwarding ${key} disabled. Install: sudo apt install -y socat`);
      } else {
        console.error(`[PortForwarder] socat spawn error for ${key}: ${err.message}`);
      }
    });
  }

  private async resolveContainerIP(): Promise<string> {
    const ip = await runDocker([
      "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      this.containerName,
    ]);
    if (!ip) throw new Error(`[PortForwarder] Cannot resolve IP for container ${this.containerName}`);
    return ip;
  }
}
