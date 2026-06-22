/** @desc Gateway — manages instances and server lifecycle */

import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import type { GatewayContext } from "./types.js";
import type { InstanceHandle, InstanceConfig } from "../core/types.js";
import { createInstanceHandle } from "./instance-handle-ipc.js";
import { cleanupOrphanWorkers } from "./worker-lifecycle.js";
import type { GatewayJsonConfig, GatewayRoute } from "./config.js";
import { PackRegistry } from "./packs/pack-registry.js";
import { PackWatcher } from "./packs/pack-watcher.js";
import { TeamUpdatePoller } from "./team/poller.js";
import { PortAllocator } from "./port-allocator.js";
import { ensureSharedConfigs } from "../defaults/index.js";
import { resolveInstanceDir, removeInstance } from "./instance-provision.js";
import { readInstanceMeta, writeInstanceMeta, removeInstanceMeta, discoverInstances } from "./instance-registry.js";
import { loadPack, saveBackup, restoreBackup, deleteBackup as deleteBackupFs, updateManifest as updateManifestFs, removeContainers as removeContainersFs, updateTeam as updateTeamFs, previewSync as previewSyncFs, executeSync as executeSyncFs, type UpdateTeamResult, type SyncPreview } from "./team/index.js";
import type { GatewayServer } from "./server/gateway-server.js";
import { detectRemoteDefaultBranch } from "../git-common/git-utils.js";

export class Gateway {
  private server: GatewayServer | null = null;
  private instances = new Map<string, InstanceHandle & { _pushPortMappings(m: import("./port-allocator.js").PortMapping[]): void; _setStatusMessage(msg?: string): void }>();
  private defaultInstanceId: string | null = null;
  private readonly config: GatewayJsonConfig;
  private readonly stateDir: string;
  private readonly templateDir = process.cwd();
  private sharedReady = false;
  private _packRegistry: PackRegistry | null = null;
  private _packWatcher: PackWatcher | null = null;
  private _teamPoller: TeamUpdatePoller | null = null;
  private _shutdownRequested = false;
  private readonly portAllocator: PortAllocator;
  private crashCounts = new Map<string, number>();
  private crashResetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _teamBusy = new Set<string>();

  constructor(config: GatewayJsonConfig, stateDir: string) {
    this.config = config;
    this.stateDir = stateDir;
    this.portAllocator = new PortAllocator(config.ports);
  }

  get packRegistry(): PackRegistry {
    if (!this._packRegistry) throw new Error("Gateway shared layer not initialized yet");
    return this._packRegistry;
  }

  private async ensureSharedLayer(): Promise<void> {
    if (this.sharedReady) return;
    await ensureSharedConfigs(this.stateDir);
    const packsDir = join(this.stateDir, "packs");
    this._packRegistry = new PackRegistry(packsDir);
    this._packWatcher = new PackWatcher(packsDir);
    this.sharedReady = true;
  }

  async addInstance(id: string, autoStart = false): Promise<InstanceHandle> {
    if (this.instances.has(id)) throw new Error(`Instance "${id}" already exists`);

    const meta = readInstanceMeta(this.stateDir, id);
    if (!meta.createdAt) {
      writeInstanceMeta(this.stateDir, id, {
        createdAt: new Date().toISOString(),
        autoStart: true,
      });
    }

    const instanceDir = resolveInstanceDir(this.stateDir, id);
    const workerScript = join(instanceDir, "src", "instance", "instance-worker.ts");
    const fullConfig: InstanceConfig = { id, instanceDir, stateDir: this.stateDir, workerScript, templateDir: this.templateDir };
    const instance = await createInstanceHandle(fullConfig, {
      onPortsChanged: async (ports) => {
        const mappings = await this.portAllocator.allocate(id, ports);
        instance._pushPortMappings(mappings);
        if (mappings.length > 0) {
          const summary = mappings.map(m => `${m.containerPort}→${m.hostPort}`).join(", ");
          console.log(`[Gateway] Instance "${id}" ports updated: ${summary}`);
        }
      },
      onCrash: (crashedId) => {
        if (!this._shutdownRequested) this.handleInstanceCrash(crashedId);
      },
      onRestartRequested: (reqId) => {
        if (!this._shutdownRequested) this.restartInstance(reqId).catch((err) => {
          console.error(`[Gateway] Restart request for "${reqId}" failed:`, err);
        });
      },
    });
    this.instances.set(id, instance);
    if (!this.defaultInstanceId) this.defaultInstanceId = id;
    // Subscribe WsHandler to this instance's event bus so its events get broadcast.
    this.server?.subscribeInstance(id);
    if (autoStart) await this.startInstance(id);
    return instance;
  }

  attachServer(server: GatewayServer): void {
    this.server = server;
  }

  async start(): Promise<void> {
    cleanupOrphanWorkers(this.stateDir);
    await this.ensureSharedLayer();

    // Bind HTTP port first so launcher and channels can connect immediately
    if (this.server) {
      this.server.attach(this.buildContext());
      await this.server.start();
    }

    this.installSignalHandlers();

    // Boot instances in background — status visible via /api/instances
    for (const id of this.instances.keys()) {
      this.startInstance(id).catch((err) => {
        console.error(`[Gateway] Instance "${id}" failed to start: ${err}`);
      });
    }

    // Pack directory watcher
    if (this._packWatcher) {
      this._packWatcher.start().catch((err) => {
        console.warn("[Gateway] PackWatcher failed to start:", err);
      });
    }

    // Team update poller (10s interval)
    this._teamPoller = new TeamUpdatePoller(this);
    this._teamPoller.start();
  }

  /** Return IDs of instances that are currently running (for poller). */
  listRunningInstances(): string[] {
    const ids: string[] = [];
    for (const [id, inst] of this.instances) {
      if (inst.status === "running") ids.push(id);
    }
    return ids;
  }

  // ─── Route resolution ───

  resolveRoute(externalId: string): { instance: InstanceHandle; agentId?: string } | null {
    const routes = this.config.routes;
    if (!routes || routes.length === 0) {
      return this.defaultInstanceId
        ? { instance: this.instances.get(this.defaultInstanceId)! }
        : null;
    }

    let fallback: GatewayRoute | undefined;
    for (const r of routes) {
      if (r.externalId === externalId) {
        const inst = this.instances.get(r.instanceId);
        if (inst) return { instance: inst, agentId: r.agentId };
      }
      if (r.externalId === "*") fallback = r;
    }

    if (fallback) {
      const inst = this.instances.get(fallback.instanceId);
      if (inst) return { instance: inst, agentId: fallback.agentId };
    }

    return this.defaultInstanceId
      ? { instance: this.instances.get(this.defaultInstanceId)! }
      : null;
  }

  // ─── Dynamic instance management (for HTTP API) ───

  /**
   * Shared pre-start routine: stamp manifest + clear status.
   * Called by both startInstance and restartInstance so every launch path
   * goes through the same preparation.
   */
  private async _prepareInstance(id: string): Promise<void> {
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    await updateManifestFs(instanceDir, { lastStartedAt: new Date().toISOString() }).catch((e) =>
      console.warn(`[Gateway] manifest stamp for "${id}" failed (non-fatal):`, e),
    );
    this.instances.get(id)!._setStatusMessage(undefined);
  }

  async startInstance(id: string): Promise<void> {
    if (!this.instances.has(id)) {
      await this.addInstance(id);
      return;
    }
    await this._prepareInstance(id);
    const inst = this.instances.get(id)!;
    inst.start().catch((e) =>
      console.error(`[Gateway] start failed for "${id}":`, e),
    );
  }

  async stopInstance(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;
    await inst.stop();
  }

  async restartInstance(id: string): Promise<void> {
    if (!this.instances.has(id)) {
      await this.addInstance(id, true);
      return;
    }
    const inst = this.instances.get(id)!;
    try {
      await inst.stop({ hard: true });
      await this._prepareInstance(id);
      await inst.start();
    } catch (err) {
      inst._setStatusMessage(err instanceof Error ? err.message : String(err));
      throw err;
    }
    inst.emit({
      source: "gateway",
      type: "instance_restarted",
      payload: { instanceId: id },
      ts: Date.now(),
    });
  }

  async shutdownInstance(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;
    await inst.shutdown();
    this.portAllocator.release(id);
    this.instances.delete(id);
    if (this.defaultInstanceId === id) {
      this.defaultInstanceId = this.instances.keys().next().value ?? null;
    }
    console.log(`[Gateway] Instance "${id}" unloaded`);
  }

  async freeInstance(id: string): Promise<void> {
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    const inst = this.instances.get(id);
    if (inst) {
      try { await inst.shutdown(); } catch (e) {
        console.error(`[Gateway] shutdown during free failed for "${id}":`, e);
      }
      this.portAllocator.release(id);
      this.instances.delete(id);
      if (this.defaultInstanceId === id) {
        this.defaultInstanceId = this.instances.keys().next().value ?? null;
      }
    }
    await removeContainersFs(instanceDir);
    removeInstanceMeta(this.stateDir, id);
    removeInstance(instanceDir, id, this.templateDir);
    console.log(`[Gateway] Instance "${id}" freed`);
  }

  // ─── Instance sync ───

  async syncInstance(id: string): Promise<{ status: "ok" | "conflict"; message: string }> {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Instance "${id}" not found`);

    const instanceDir = resolveInstanceDir(this.stateDir, id);

    await this.stopInstance(id);

    try {
      execSync("git fetch origin", { cwd: instanceDir, stdio: "ignore", timeout: 30_000 });
      const branch = detectRemoteDefaultBranch(instanceDir);
      execSync(`git merge origin/${branch} --no-edit`, { cwd: instanceDir, stdio: "pipe", timeout: 30_000 });
    } catch {
      try { execSync("git merge --abort", { cwd: instanceDir, stdio: "ignore" }); } catch {}
      return { status: "conflict", message: "Merge conflict detected. Instance left at previous version." };
    }

    await this.startInstance(id);

    return { status: "ok", message: "Synced and restarted." };
  }

  // ─── Crash recovery ───

  /**
   * Scan loaded instances and free any whose directory has been removed externally.
   * Called periodically by TeamUpdatePoller, and on-demand from crash handler.
   */
  async reapDeletedInstances(): Promise<void> {
    for (const id of [...this.instances.keys()]) {
      const dir = resolveInstanceDir(this.stateDir, id);
      if (!existsSync(dir)) {
        console.log(`[Gateway] Instance "${id}" directory removed externally — freeing.`);
        try { await this.freeInstance(id); } catch (err) {
          console.error(`[Gateway] freeInstance for externally deleted "${id}" failed:`, err);
        }
      }
    }
  }

  private async handleInstanceCrash(id: string): Promise<void> {
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    if (!existsSync(instanceDir)) {
      await this.reapDeletedInstances();
      return;
    }

    const MAX_RESTARTS = 5;
    const BACKOFF_BASE = 2000;
    const STABLE_THRESHOLD_MS = 60_000;

    const count = (this.crashCounts.get(id) ?? 0) + 1;
    this.crashCounts.set(id, count);

    if (count > MAX_RESTARTS) {
      console.error(`[Gateway] Instance "${id}" crashed ${count} times. Giving up.`);
      return;
    }

    const delay = BACKOFF_BASE * Math.pow(2, count - 1);
    console.log(`[Gateway] Hard-restarting "${id}" in ${delay}ms (attempt ${count}/${MAX_RESTARTS})...`);

    await new Promise(r => setTimeout(r, delay));

    if (this._shutdownRequested) return;

    try {
      if (!this.instances.has(id)) return;
      await this.restartInstance(id);

      const prev = this.crashResetTimers.get(id);
      if (prev) clearTimeout(prev);
      this.crashResetTimers.set(id, setTimeout(() => {
        this.crashCounts.delete(id);
        this.crashResetTimers.delete(id);
      }, STABLE_THRESHOLD_MS));

      console.log(`[Gateway] Instance "${id}" hard-restarted successfully.`);
    } catch (err) {
      console.error(`[Gateway] Failed to restart instance "${id}":`, err);
    }
  }

  // ─── Team operations (Gateway-level orchestration) ───

  async teamLoad(id: string, packId: string, opts?: { forkId?: string }): Promise<void> {
    await this.shutdownInstance(id);
    let effectivePackId = packId;
    if (opts?.forkId) {
      effectivePackId = await this.packRegistry.fork(packId, opts.forkId);
    }
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    const packsDir = join(this.stateDir, "packs");
    await loadPack(instanceDir, effectivePackId, packsDir);
    await this.addInstance(id);
    this.startInstance(id).catch((e) =>
      console.error(`[Gateway] teamLoad start failed for "${id}":`, e),
    );
  }

  async teamSave(id: string, name: string): Promise<void> {
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    await saveBackup(instanceDir, name);
  }

  async teamRestore(id: string, backupName: string): Promise<void> {
    await this.shutdownInstance(id);
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    await restoreBackup(instanceDir, backupName);
    await this.addInstance(id);
    await this.startInstance(id);
  }

  async teamUpdateManifest(id: string, patch: Record<string, unknown>): Promise<void> {
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    await updateManifestFs(instanceDir, patch);
  }

  async teamUpdate(id: string): Promise<UpdateTeamResult> {
    return this._withTeamLock(id, async () => {
      const instanceDir = resolveInstanceDir(this.stateDir, id);
      const packsDir = join(this.stateDir, "packs");
      return updateTeamFs(instanceDir, packsDir);
    });
  }

  async teamDeleteBackup(id: string, backupName: string): Promise<void> {
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    await deleteBackupFs(instanceDir, backupName);
  }

  async teamRemoveContainers(id: string): Promise<{ removed: string[] }> {
    const instanceDir = resolveInstanceDir(this.stateDir, id);
    return removeContainersFs(instanceDir);
  }

  async teamSyncPreview(id: string): Promise<SyncPreview> {
    return this._withTeamLock(id, async () => {
      const instanceDir = resolveInstanceDir(this.stateDir, id);
      const packsDir = join(this.stateDir, "packs");
      return previewSyncFs(instanceDir, packsDir);
    });
  }

  async teamSyncExecute(id: string, newVersion: string): Promise<void> {
    return this._withTeamLock(id, async () => {
      const instanceDir = resolveInstanceDir(this.stateDir, id);
      const packsDir = join(this.stateDir, "packs");
      await executeSyncFs(instanceDir, packsDir, newVersion);
    });
  }

  // ─── Shutdown ───

  async shutdownGateway(): Promise<void> {
    if (this._shutdownRequested) return;
    this._shutdownRequested = true;
    const timeout = setTimeout(() => { this.cleanupPidFile(); process.exit(1); }, 10_000);
    await this.shutdown();
    clearTimeout(timeout);
    this.cleanupPidFile();
    process.exit(0);
  }

  private installSignalHandlers(): void {
    const graceful = (signal: string) => {
      console.log(`收到 ${signal}，正在关闭...`);
      this.shutdownGateway();
    };

    process.on("SIGINT", () => { graceful("SIGINT"); });
    process.on("SIGTERM", () => { graceful("SIGTERM"); });
  }

  private cleanupPidFile(): void {
    try {
      unlinkSync(join(this.stateDir, "gateway.pid"));
    } catch {}
  }

  async shutdown(): Promise<void> {
    if (this._teamPoller) {
      this._teamPoller.stop();
    }
    if (this._packWatcher) {
      this._packWatcher.stop();
    }
    if (this.server) {
      await this.server.stop();
    }
    for (const instance of this.instances.values()) {
      try { await instance.shutdown(); } catch {}
    }
    for (const [id] of this.instances) {
      this.portAllocator.release(id);
    }
  }

  private buildContext(): GatewayContext {
    return {
      stateDir: this.stateDir,
      getInstance: (id) => this.instances.get(id),
      getDefaultInstance: () => {
        const inst = this.instances.get(this.defaultInstanceId!);
        if (!inst) throw new Error("No default instance available");
        return inst;
      },
      listInstances: () => {
        const all = discoverInstances(this.stateDir);
        return all.map(({ id, meta }) => {
          const running = this.instances.get(id);
          return {
            id,
            status: running?.status ?? "unloaded",
            statusMessage: running?.statusMessage,
            provisioningPhase: running?.provisioningPhase,
            autoStart: meta.autoStart,
            createdAt: meta.createdAt,
          };
        });
      },
      packRegistry: this.packRegistry,
      packCleanImage: (packId) => this.packRegistry.cleanImage(packId),
      resolveRoute: (externalId) => this.resolveRoute(externalId),
      addInstance: (id) => this.addInstance(id, true),
      startInstance: (id) => this.startInstance(id),
      stopInstance: (id) => this.stopInstance(id),
      shutdownInstance: (id) => this.shutdownInstance(id),
      restartInstance: (id) => this.restartInstance(id),
      freeInstance: (id) => this.freeInstance(id),
      syncInstance: (id) => this.syncInstance(id),
      getPortMappings: (id) => this.portAllocator.getMappings(id),
      shutdownGateway: () => this.shutdownGateway(),
      teamLoad: (id, packId, opts) => this.teamLoad(id, packId, opts),
      teamSave: (id, n) => this.teamSave(id, n),
      teamRestore: (id, b) => this.teamRestore(id, b),
      teamUpdateManifest: (id, patch) => this.teamUpdateManifest(id, patch),
      teamUpdate: (id) => this.teamUpdate(id),
      teamDeleteBackup: (id, name) => this.teamDeleteBackup(id, name),
      teamRemoveContainers: (id) => this.teamRemoveContainers(id),
      teamSyncPreview: (id) => this.teamSyncPreview(id),
      teamSyncExecute: (id, v) => this.teamSyncExecute(id, v),
    };
  }

  // ─── Per-instance team operation lock ───

  private async _withTeamLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
    if (this._teamBusy.has(instanceId)) {
      throw new Error(`Another team operation is already in progress for instance "${instanceId}"`);
    }
    this._teamBusy.add(instanceId);
    try {
      return await fn();
    } finally {
      this._teamBusy.delete(instanceId);
    }
  }
}

