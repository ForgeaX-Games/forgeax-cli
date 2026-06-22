#!/usr/bin/env node
/**
 * @desc Ink Renderer subscriber — connects to Gateway via plain WS, renders TUI via React/Ink.
 *
 * Standalone entry point. Instance selection: MC_TARGET_INSTANCE env var
 * or CLI arg, with fallback to renderer.json cache.
 *
 * Switching instances from inside the TUI just updates a local
 * `currentInstanceId` (no server notification needed — Gateway broadcasts
 * every instance event to every authed WS client and the subscriber filters
 * locally).
 */

import { join } from "node:path";
import type WebSocket from "ws";
import { resolveStateDir } from "../fs/state-dir.js";
import {
  loadConnInfo, apiCall, connectGatewayWs,
  type ConnInfo,
} from "../channels/shared/gateway-conn.js";
import type { DraftSnapshot } from "../channels/ink-renderer/lib/renderer-config.js";
import type { CommandSpec, CommandResult } from "../capability/command/types.js";
import { rendererCacheStore, type InkCache } from "../channels/ink-renderer/lib/renderer-cache-store.js";

const stateDir = resolveStateDir();

// ─── Per-instance agent + per-(instance,agent) draft cache ───
//
// Stored at <stateDir>/cache/renderer/ink-cache.json. Schema:
//   { agentByInstance: { [instanceId]: agentId },
//     drafts:          { [instanceId]: { [agentId]: DraftSnapshot } } }
//
// Drafts hold the user's in-flight input box segments and the reserved-queue
// contents so an `agenteam` restart restores exactly where the user left off,
// scoped per (instance, agent) since each conversation has its own context.

/**
 * Mutate `cache.drafts` for (instId, agent). Empty drafts (no input + no
 * queue) prune the entry — and the parent map if it becomes empty — so the
 * file never grows stale `{}` stubs. Returns whether any change was made.
 */
function applyDraft(cache: InkCache, instId: string, agent: string, draft: DraftSnapshot): boolean {
  const empty = !draft.inputSegments?.length && !draft.reservedQueue?.length;
  const existing = cache.drafts?.[instId]?.[agent];
  if (empty) {
    if (!existing) return false;
    delete cache.drafts![instId]![agent];
    if (Object.keys(cache.drafts![instId]!).length === 0) delete cache.drafts![instId];
    return true;
  }
  ((cache.drafts ??= {})[instId] ??= {})[agent] = draft;
  return true;
}

// ─── Ink Renderer subscriber ───

class InkRendererSubscriber {
  private renderer: { stop(): void; start(): Promise<void>; setConnectionState(connected: boolean): void } | null = null;
  private observers = new Set<(event: Record<string, unknown>, emitterId?: string) => void>();
  private currentInstanceId: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private readonly conn: ConnInfo;
  /** Pending command RPCs: requestId → resolver (30s timeout, then rejects). */
  private pendingCommands = new Map<string, (result: CommandResult) => void>();
  private nextRequestId = 0;

  private static readonly BASE_DELAY_MS = 2_000;
  private static readonly MAX_DELAY_MS = 30_000;

  constructor(opts: { instanceId: string }) {
    this.currentInstanceId = opts.instanceId;
    this.conn = loadConnInfo(stateDir);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  /** Connect WS → spawn event loop + close handler → run business init. */
  private async connect(): Promise<void> {
    const newWs = await connectGatewayWs(this.conn);
    this.ws = newWs;
    this.reconnectAttempt = 0;

    // Event loop: filter by current instanceId, fan out to observers.
    newWs.on("message", (raw: Buffer) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString("utf-8")); } catch { return; }
      // Command RPC reply
      if (frame.type === "command_result") {
        const requestId = frame.requestId as string | undefined;
        if (!requestId) return;
        const resolve = this.pendingCommands.get(requestId);
        if (!resolve) return;
        this.pendingCommands.delete(requestId);
        resolve(frame.result as CommandResult);
        return;
      }
      if (frame.type !== "event" || frame.instanceId !== this.currentInstanceId || !frame.event) return;
      const event = frame.event as Record<string, unknown>;
      const emitterId = frame.emitterId as string | undefined;
      for (const h of this.observers) {
        try { h(event, emitterId); } catch {}
      }
    });

    // Close handler: reconnect unless intentionally stopped.
    newWs.on("close", (code: number) => {
      if (this.stopped || code === 1000 || code === 4001) return;
      this.renderer?.setConnectionState(false);
      void this.reconnect();
    });

    // Business init — onReady wires up renderer / dataSource / callbacks.
    // Init failures throw, propagating to start()'s caller (main().catch()).
    await this.onReady();
  }

  /** Exponential-backoff reconnect (2s → 30s cap). Stops on `stopped` flag. */
  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    this.reconnectAttempt++;
    const delay = Math.min(
      InkRendererSubscriber.BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1),
      InkRendererSubscriber.MAX_DELAY_MS,
    );
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (err) {
      process.stderr.write(`[ink-renderer] reconnect failed: ${(err as Error)?.message ?? String(err)}\n`);
      void this.reconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.renderer?.stop();
    this.renderer = null;
    this.observers.clear();
    // Reject any in-flight command RPCs to prevent hang on shutdown
    for (const resolve of this.pendingCommands.values()) {
      resolve({ ok: false, error: "Subscriber stopped" });
    }
    this.pendingCommands.clear();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  /** Local filter switch — no server notification (Gateway broadcasts all). */
  private setInstanceId(newId: string): void {
    this.currentInstanceId = newId;
  }

  /** Send an emit frame tagged with the current instanceId. No-op if WS isn't open. */
  private sendEmit(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({
      type: "emit",
      instanceId: this.currentInstanceId,
      event,
    }));
  }

  /**
   * Command RPC roundtrip. Resolves on matching `command_result` or 30s timeout.
   * Never rejects — errors are always wrapped as { ok: false, error }.
   */
  private sendCommandRequest(
    type: "list_commands" | "command_query" | "command_execute",
    payload: Record<string, unknown>,
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) {
        resolve({ ok: false, error: "WS not connected" });
        return;
      }
      const requestId = `cmd-${++this.nextRequestId}-${Date.now()}`;
      let timer: NodeJS.Timeout | null = null;
      const wrappedResolve = (result: CommandResult) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      this.pendingCommands.set(requestId, wrappedResolve);
      timer = setTimeout(() => {
        if (this.pendingCommands.has(requestId)) {
          this.pendingCommands.delete(requestId);
          wrappedResolve({ ok: false, error: "Command timeout (30s)" });
        }
      }, 30_000);
      this.ws.send(JSON.stringify({
        type,
        instanceId: this.currentInstanceId,
        requestId,
        ...payload,
      }));
    });
  }

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${ts}] [ink-renderer] ${msg}\n`);
  }

  private async onReady(): Promise<void> {
    const conn = this.conn;
    // `self` captures `this` for use inside dataSource / callbacks closures.
    // Inside those closures, `self.currentInstanceId` is read at call time,
    // so switching instance reflects immediately.
    const self = this;
    void self.log;  // silence unused warning when log is removed in future

    // ─── Remote DataSource ───

    const dataSource: import("../channels/ink-renderer/lib/renderer-config.js").RendererDataSource = {
      async listAgents() {
        const r = await self.sendCommandRequest("command_query", { name: "list_agents", args: [] });
        if (!r.ok) return [];
        return ((r.data as Array<{ id: string }>) ?? []).map((n) => n.id);
      },
      async listSessions(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "list_sessions", args: [agentId] });
        if (!r.ok) return [];
        return ((r.data as Record<string, unknown>)?.sessions as string[]) ?? [];
      },
      async fetchAllEvents(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_session_events", args: [agentId] });
        if (!r.ok) return "";
        return typeof r.data === "string" ? r.data : "";
      },
      readRendererState() {
        return {};
      },
      async writeRendererActiveAgent(agent: string) {
        rendererCacheStore.update((cache) => {
          if (!cache.agentByInstance) cache.agentByInstance = {};
          cache.agentByInstance[self.currentInstanceId] = agent;
        });
      },
      async fetchDefaultAgent() {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_default_agent", args: [] });
        if (!r.ok) return null;
        return typeof r.data === "string" ? r.data : null;
      },
      async fetchControlOverview() {
        try {
          const { status, data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(self.currentInstanceId)}/control-plane/overview`);
          if (status >= 400) return null;
          return JSON.stringify((data as Record<string, unknown>).overview ?? data, null, 2);
        } catch { return null; }
      },
      async listInstances() {
        const { listInstances: listInst } = await import("../channels/shared/gateway-conn.js");
        const all = await listInst(conn);
        return all.map(i => ({ id: i.id, status: i.status, statusMessage: i.statusMessage }));
      },
      readCachedAgent(instanceId: string) {
        return rendererCacheStore.snapshot().agentByInstance?.[instanceId] ?? null;
      },
      async writeCachedAgent(instanceId: string, agent: string) {
        rendererCacheStore.update((cache) => {
          if (!cache.agentByInstance) cache.agentByInstance = {};
          cache.agentByInstance[instanceId] = agent;
        });
      },
      readDraft(instanceId: string, agent: string) {
        return rendererCacheStore.snapshot().drafts?.[instanceId]?.[agent] ?? null;
      },
      async writeDraft(instanceId: string, agent: string, draft: DraftSnapshot) {
        rendererCacheStore.update((cache) => applyDraft(cache, instanceId, agent, draft));
      },
      writeDraftSync(instanceId: string, agent: string, draft: DraftSnapshot) {
        let changed = false;
        rendererCacheStore.update((cache) => {
          changed = applyDraft(cache, instanceId, agent, draft);
          return changed;
        });
        if (changed) rendererCacheStore.flushSync();
      },
      async isAgentRunning(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "is_agent_running", args: [agentId] });
        if (!r.ok) return false;
        return r.data === true;
      },
      async getAgentStatus(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "get_agent_status", args: [agentId] });
        if (!r.ok) return "";
        return typeof r.data === "string" ? r.data : "";
      },
      async fetchAgentTree() {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_agent_tree", args: [] });
        if (!r.ok) return [];
        return (r.data as import("../core/types.js").AgentNodeData[]) ?? [];
      },
      async fetchTeamBoard(agentId?: string) {
        const args: string[] = agentId ? [agentId] : [];
        const r = await self.sendCommandRequest("command_query", { name: "fetch_teamboard", args });
        if (!r.ok) return {};
        return (r.data as Record<string, Record<string, unknown>>) ?? {};
      },
      async fetchAgentJson(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "fetch_agent_json", args: [agentId] });
        if (!r.ok) return null;
        return (r.data as Record<string, unknown>) ?? null;
      },
      async listAvailableModels() {
        try {
          const { status, data } = await apiCall(conn, "GET", "/api/models");
          if (status >= 400) return [];
          return Object.keys((data as Record<string, unknown>) ?? {}).sort();
        } catch { return []; }
      },
      async readAgentOverrides(agentId: string) {
        const r = await self.sendCommandRequest("command_query", { name: "read_agent_overrides", args: [agentId] });
        if (!r.ok) return {};
        return (r.data as Record<string, unknown>) ?? {};
      },
      async writeAgentOverrides(agentId: string, patch: Record<string, unknown>) {
        const r = await self.sendCommandRequest("command_execute", { name: "write_agent_overrides", args: [agentId, JSON.stringify(patch)] });
        if (!r.ok) throw new Error(r.error ?? "Failed to write overrides");
      },
      async addInstance(id: string) {
        const { status, data } = await apiCall(conn, "POST", "/api/instances", { id }, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to create instance (${status})`);
        const d = data as Record<string, unknown>;
        return { id: (d.id as string) ?? id, status: (d.status as string) ?? "unknown" };
      },
      async freeInstance(id: string) {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/free`, undefined, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to free instance (${status})`);
      },
      async freeAgent(_instanceId: string, agentId: string) {
        // _instanceId is part of the legacy interface but unused here —
        // sendCommandRequest internally uses self.currentInstanceId.
        const r = await self.sendCommandRequest("command_execute", { name: "free_agent", args: [agentId] });
        if (!r.ok) throw new Error(r.error ?? "Failed to free agent");
      },
      async listPacks() {
        const { status, data } = await apiCall(conn, "GET", "/api/packs");
        if (status >= 400) return [];
        const packs = (data as Record<string, unknown>).packs as Array<Record<string, unknown>> ?? [];
        return packs.map(p => ({
          id: p.id as string,
          version: p.version as string | undefined,
          isBuilt: p.isBuilt as boolean ?? false,
        }));
      },
      async packCleanImage(packId: string) {
        const { status, data } = await apiCall(conn, "DELETE", `/api/packs/${encodeURIComponent(packId)}/image`, undefined, { timeoutMs: 60_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to clean image (${status})`);
        const d = data as Record<string, unknown>;
        return { imageRemoved: d.imageRemoved as boolean ?? false, tarRemoved: d.tarRemoved as boolean ?? false };
      },
      async removeContainers(instanceId: string) {
        const { status, data } = await apiCall(conn, "DELETE", `/api/instances/${encodeURIComponent(instanceId)}/team/containers`, undefined, { timeoutMs: 30_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Failed to remove containers (${status})`);
        return { removed: ((data as Record<string, unknown>).removed as string[]) ?? [] };
      },
      async teamSyncPreview() {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(self.currentInstanceId)}/team/sync-preview`);
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Sync preview failed (${status})`);
        const d = data as Record<string, unknown>;
        return {
          packId: d.packId as string ?? "",
          currentVersion: d.currentVersion as string ?? "1.0.0",
          files: (d.files as Array<{ path: string; status: string }>) ?? [],
        };
      },
      async teamSyncExecute(newVersion: string) {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(self.currentInstanceId)}/team/sync`, { newVersion }, { timeoutMs: 30_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Sync failed (${status})`);
      },
      async restartInstance(instanceId: string) {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instanceId)}/restart`, undefined, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Restart failed (${status})`);
      },
      async teamLoad(instanceId: string, packId: string, forkId?: string) {
        const body: Record<string, unknown> = { packId };
        if (forkId) body.forkId = forkId;
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instanceId)}/team/load`, body, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Load pack failed (${status})`);
      },
      async fetchTeamInfo(instanceId: string) {
        const { status, data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(instanceId)}/team`);
        if (status >= 400) return { team: null, backups: [] };
        const d = data as Record<string, unknown>;
        return {
          team: (d.team as any) ?? null,
          backups: (d.backups as string[]) ?? [],
        };
      },
      async teamRestore(instanceId: string, backupName: string) {
        const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(instanceId)}/team/restore`, { backupName }, { timeoutMs: 120_000 });
        if (status >= 400) throw new Error((data as Record<string, unknown>).error as string ?? `Restore failed (${status})`);
      },
    };

    // ─── Remote Callbacks ───
    //
    // emit goes through this.sendEmit, which automatically tags the frame with
    // the *current* instanceId (so switching instance is immediate).

    const observers = this.observers;

    const callbacks: import("../channels/ink-renderer/lib/renderer-config.js").RendererCallbacks = {
      onUserInput(agentId, content, handoff, display) {
        self.sendEmit({
          source: "user", type: "user_input",
          payload: { content, display },
          ts: Date.now(), to: agentId, handoff,
        });
      },
      onAgentCommand(agentId, toolName, cmdArgs) {
        self.sendEmit({
          source: "user", type: "agent_command",
          payload: { toolName, args: cmdArgs, agentId },
          ts: Date.now(),
        });
      },
      observeEvents(handler) {
        const h = (event: Record<string, unknown>, emitterId?: string) => {
          handler(event as Parameters<typeof handler>[0], emitterId);
        };
        observers.add(h);
        return () => { observers.delete(h); };
      },
      emitEvent(event) {
        self.sendEmit(event);
      },

      // ── Command system (Phase 1.1) ──
      async listCommands(requestingAgentId?: string) {
        const result = await self.sendCommandRequest("list_commands", { requestingAgentId });
        if (!result.ok) return [];
        return result.data as CommandSpec[];
      },
      async commandQuery(name: string, args: string[], requestingAgentId?: string) {
        return self.sendCommandRequest("command_query", { name, args, requestingAgentId });
      },
      async commandExecute(name: string, args: string[], requestingAgentId?: string) {
        return self.sendCommandRequest("command_execute", { name, args, requestingAgentId });
      },
    };

    // ─── Launch InkRenderer (clean up previous instance on reconnect) ───

    this.renderer?.stop();
    this.observers.clear();

    const { clearScreen } = await import("../channels/shared/ansi.js");
    clearScreen();
    const { setMediasDir } = await import("../channels/shared/media-dir.js");
    setMediasDir(join(stateDir, "cache", "renderer", "medias"));

    const { InkRenderer } = await import("../channels/ink-renderer/index.js");
    const renderer = new InkRenderer(callbacks, dataSource);
    this.renderer = renderer;

    renderer.setSwitchInstanceCallback((newId: string) => {
      self.setInstanceId(newId);
    });

    renderer.setConnectionState(true);

    renderer.setInterruptCallback((agentId) => {
      const qs = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
      apiCall(conn, "POST", `/api/instances/${encodeURIComponent(self.currentInstanceId)}/interrupt${qs}`).catch(() => {});
    });

    // Second Ctrl+C within 2s exits the app
    renderer.setExitCallback(() => {
      this.stop().then(() => process.exit(0));
    });

    await renderer.start();

    // Fallback SIGINT handler for edge cases where raw mode is temporarily off
    process.on("SIGINT", () => {
      this.stop().then(() => process.exit(0));
    });
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
    try {
      const { resolveInstanceId: resolve, listInstances: listInst } = await import("../channels/shared/gateway-conn.js");
      const conn = loadConnInfo(stateDir);
      const resolved = await resolve(conn);
      if (resolved.instanceId !== null) {
        instanceId = resolved.instanceId;
        if (resolved.note) process.stdout.write(`${resolved.note}\n`);
      } else {
        const all = await listInst(conn);
        if (all.length > 0) {
          instanceId = all[0].id;
          process.stdout.write(`所有实例均未就绪，连接到 "${instanceId}"\n`);
        }
      }
    } catch {}
  }

  const sub = new InkRendererSubscriber({
    instanceId: instanceId ?? "",
  });

  await sub.start();
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
