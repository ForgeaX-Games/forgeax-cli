// @desc RendererConfig — state persistence, data source abstraction, active agent resolution

import type { EventContent, EventHandoff } from "../../../core/types.js";
import type { CommandSpec, CommandResult } from "../../../capability/command/types.js";
import type { InputSegment } from "../../shared/input-segments.js";

export interface RendererCallbacks {
  onUserInput(agentId: string, content: EventContent, handoff: EventHandoff, display?: { text: string; segments: InputSegment[] }): void;
  onAgentCommand(agentId: string, toolName: string, args: Record<string, string>): void;
  observeEvents(handler: (event: { source: string; type: string; payload: unknown; to?: string }, emitterId?: string) => void): () => void;
  emitEvent(event: { source: string; type: string; payload: unknown; ts: number; to?: string }): void;

  // ── Command system (Phase 1.1) — optional so older subscribers stay compatible ──
  /** Pull command list from worker. */
  listCommands?(requestingAgentId?: string): Promise<CommandSpec[]>;
  /** Run a worker command's read-only `query`. `args` is positional (see CommandModule). */
  commandQuery?(name: string, args: string[], requestingAgentId?: string): Promise<CommandResult>;
  /** Run a worker command's `execute` (side effects). `args` is positional. */
  commandExecute?(name: string, args: string[], requestingAgentId?: string): Promise<CommandResult>;
}

interface RendererStateJson {
  activeAgent?: string;
  [key: string]: unknown;
}

export interface ResolvedContext {
  agent: string;
  session: string;
  needsSelection: boolean;
}

/**
 * Persisted per-(instance, agent) input draft.
 *
 * Restored on `agenteam` start so the user can pick up where they left off.
 * Both fields are optional — an entry exists only when there is something to
 * restore. media segments may carry large base64 payloads but we still
 * persist them as-is; the cache writer is free to drop oversize entries.
 */
export interface DraftSnapshot {
  inputSegments?: InputSegment[];
  reservedQueue?: Array<{
    id: string;
    text: string;
    segments: InputSegment[];
    visualDisplay: string;
    createdAt: number;
  }>;
}

/**
 * Data access abstraction for the renderer.
 * All data flows through the gateway HTTP API — renderer never touches the filesystem.
 */
export interface RendererDataSource {
  listAgents(): Promise<string[]>;
  listSessions(agentId: string): Promise<string[]>;
  /** Fetch events as raw JSONL text for the active session of an agent. */
  fetchAllEvents(agentId: string): Promise<string>;
  readRendererState(): RendererStateJson;
  writeRendererActiveAgent(agent: string): Promise<void>;
  /** Fetch team's defaultAgent hint. Returns null if not set or unavailable. */
  fetchDefaultAgent?(): Promise<string | null>;
  /** Fetch control plane overview (optional). */
  fetchControlOverview?(): Promise<string | null>;
  /** List all available instances from the Gateway. */
  listInstances?(): Promise<Array<{ id: string; status: string; statusMessage?: string; provisioningPhase?: string }>>;
  /** Read cached agent for a given instance. Returns null if not cached. */
  readCachedAgent?(instanceId: string): string | null;
  /** Cache agent selection for a given instance. */
  writeCachedAgent?(instanceId: string, agent: string): Promise<void>;
  /** Check whether an agent is currently running (from TeamBoard RUNNING state). */
  isAgentRunning?(agentId: string): Promise<boolean>;
  /** Fetch the agent's operational STATUS from TeamBoard (e.g. "plan_mode"). */
  getAgentStatus?(agentId: string): Promise<string>;
  /** Fetch the full agent tree (node list with roles and hierarchy). */
  fetchAgentTree?(): Promise<import("../../../core/types.js").AgentNodeData[]>;
  /** Fetch TeamBoard variables. If agentId is omitted, returns all agents' boards. */
  fetchTeamBoard?(agentId?: string): Promise<Record<string, Record<string, unknown>>>;
  /** Fetch the agent.json configuration for a specific agent. */
  fetchAgentJson?(agentId: string): Promise<Record<string, unknown> | null>;
  /** List model names available in key/models.json (the model catalog). */
  listAvailableModels?(): Promise<string[]>;
  /** Read agent-overrides.json for a specific agent. Returns {} when absent. */
  readAgentOverrides?(agentId: string): Promise<Record<string, unknown>>;
  /** Deep-merge `patch` into agent-overrides.json for a specific agent. */
  writeAgentOverrides?(agentId: string, patch: Record<string, unknown>): Promise<void>;
  /** Create a new instance. Returns id and initial status. */
  addInstance?(id: string): Promise<{ id: string; status: string }>;
  /** Permanently delete an instance (free = shutdown + rm containers + rm directory). */
  freeInstance?(id: string): Promise<void>;
  /** Permanently free an agent (shutdown + rm `agents/{id}` + rm `homes/{id}` + tree node + teamboard).
   *  Equivalent to the `free_agent` LLM tool; sessions/logs are retained for history. */
  freeAgent?(instanceId: string, agentId: string): Promise<void>;
  /** List all packs. */
  listPacks?(): Promise<Array<{ id: string; version?: string; isBuilt: boolean }>>;
  /** Delete a pack's Docker image and tar cache. */
  packCleanImage?(packId: string): Promise<{ imageRemoved: boolean; tarRemoved: boolean }>;
  /** Remove all Docker containers for an instance. */
  removeContainers?(instanceId: string): Promise<{ removed: string[] }>;
  /** Preview team→pack sync: returns packId, currentVersion, and changed files. */
  teamSyncPreview?(): Promise<{ packId: string; currentVersion: string; files: Array<{ path: string; status: string }> }>;
  /** Execute team→pack sync with a new version string. */
  teamSyncExecute?(newVersion: string): Promise<void>;
  /** Restart an instance (hard stop + re-provision + start). */
  restartInstance?(instanceId: string): Promise<void>;
  /** Load a pack into an instance's team (shutdown → copy pack → start). If forkId is provided, fork the pack first. */
  teamLoad?(instanceId: string, packId: string, forkId?: string): Promise<void>;
  /** Fetch team info (manifest + backups) for an instance. */
  fetchTeamInfo?(instanceId: string): Promise<{ team: { teamId: string; source: { type: string; id: string; version: string }; defaultAgent?: string; createdAt: string } | null; backups: string[] }>;
  /** Restore a team backup (shutdown → restore → start). */
  teamRestore?(instanceId: string, backupName: string): Promise<void>;
  /** Read the persisted draft (input box + reserved queue) for (instance, agent). */
  readDraft?(instanceId: string, agent: string): DraftSnapshot | null;
  /** Persist the draft for (instance, agent). Empty draft behaves as a clear. */
  writeDraft?(instanceId: string, agent: string, draft: DraftSnapshot): Promise<void>;
  /** Sync variant for process-exit / SIGINT paths (async writes would race teardown). */
  writeDraftSync?(instanceId: string, agent: string, draft: DraftSnapshot): void;
}

// ─── RendererConfig ───

export class RendererConfig {
  private ds: RendererDataSource;

  constructor(dataSource: RendererDataSource) {
    this.ds = dataSource;
  }

  get dataSource(): RendererDataSource {
    return this.ds;
  }

  read(): RendererStateJson {
    return this.ds.readRendererState();
  }

  async writeActiveAgent(agent: string): Promise<void> {
    await this.ds.writeRendererActiveAgent(agent);
  }

  async listAgents(): Promise<string[]> {
    return this.ds.listAgents();
  }

  async listSessions(agentId: string): Promise<string[]> {
    return this.ds.listSessions(agentId);
  }

  async fetchAllEvents(agentId: string): Promise<string> {
    return this.ds.fetchAllEvents(agentId);
  }


  async resolveActive(): Promise<ResolvedContext> {
    const agent    = this.read().activeAgent ?? "";
    const agentIds = await this.ds.listAgents();

    if (agent && agentIds.includes(agent)) {
      return { agent, session: "current", needsSelection: false };
    }

    if (this.ds.fetchDefaultAgent) {
      const defaultAgent = await this.ds.fetchDefaultAgent();
      if (defaultAgent && agentIds.includes(defaultAgent)) {
        await this.ds.writeRendererActiveAgent(defaultAgent);
        return { agent: defaultAgent, session: "current", needsSelection: false };
      }
    }

    return { agent: "", session: "", needsSelection: true };
  }
}
