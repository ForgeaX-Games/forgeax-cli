/** Instance lifecycle types — status, provisioning phases, handle, introspection. */

import type { Event } from "../core/types.js";
import type { CommandSpec, CommandResult } from "../capability/command/types.js";

// Re-exports kept for instance-queries.ts consumers (commands/introspect.ts).
export type { CapabilitiesIntrospection, CapabilityPackageDetail, CapabilityItem, CapabilityPackageSummary, CapabilityLayer, SkillsIntrospection, SkillSummary, SkillLayer, TemplatesIntrospection, TemplateLayer, TemplateSummary, TemplateDetail, BackupInfo, StoredEvent };

// ─── Instance lifecycle ───

/**
 * Instance lifecycle states.
 *
 * - idle:          no team loaded (manifest absent)
 * - provisioning:  infrastructure setup (sandbox ensure / image rebuild / scaffold)
 * - starting:      team ready, scheduler booting agents
 * - running:       agents active
 * - stopping:      stop/shutdown in progress
 * - stopped:       scheduler paused, worker alive (has team but not started)
 * - restarting:    kill worker → re-fork cycle
 * - error:         init or runtime failure
 * - unloaded:      gateway has not loaded this instance (list API only)
 */
export type InstanceStatus =
  | "idle"
  | "provisioning"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "restarting"
  | "error"
  | "unloaded";

export type ProvisioningPhase =
  | "scaffolding"
  | "initializing_sandbox"
  | "rebuilding_image"
  | "creating_container"
  | "starting_container"
  | "configuring_team";

export const PROVISIONING_PHASE_LABEL: Record<ProvisioningPhase, string> = {
  scaffolding:          "正在初始化项目结构...",
  initializing_sandbox: "正在初始化沙箱环境...",
  rebuilding_image:     "正在构建 Docker 镜像（可能需要几分钟）...",
  creating_container:   "正在创建容器...",
  starting_container:   "正在启动容器...",
  configuring_team:     "正在配置 Team 目录...",
};

/** Statuses where the instance is transitioning toward "running" — suitable for queuing messages. */
export const INSTANCE_STATUS_PENDING: ReadonlySet<InstanceStatus> = new Set(["idle", "provisioning", "starting"]);

/** Statuses that indicate a terminal failure — polling loops should exit early. */
export const INSTANCE_STATUS_TERMINAL: ReadonlySet<InstanceStatus> = new Set(["error", "stopped"]);

export interface TeamInfoPayload {
  teamId: string;
  source: { type: string; id: string; version: string };
  defaultAgent?: string;
  createdAt: string;
}

export interface InstanceHandle {
  readonly id: string;
  readonly instanceDir: string;
  readonly status: InstanceStatus;
  readonly statusMessage?: string;
  readonly provisioningPhase?: ProvisioningPhase;

  start(): Promise<void>;
  /** Soft stop (pause scheduler, process stays) or hard stop (kill process, containers stay). */
  stop(options?: { hard?: boolean }): Promise<void>;
  shutdown(): Promise<void>;
  interruptAgents(agentId?: string): void;

  observeEvents(handler: (event: Event, emitterId?: string) => void): () => void;
  emit(event: Event): void;

  // ── Commands (instance-scoped, stateless) ──
  // All read-only state queries (capabilities / skills / templates / backups /
  // team-info / agents / sessions / etc) and write-side actions (free_agent /
  // write_agent_overrides / compact / memory_search / read_skill dispatch)
  // live in commands/*.ts and are reached through these three methods. Gateway
  // exposes them over HTTP (`/api/instances/:id/commands/*`) and WS frames.
  // The three methods below are the ONLY data-plane bridge the IPC layer needs.
  /** List all available commands across instance + team layers. Each call re-scans the dirs. */
  listCommands(requestingAgentId?: string): Promise<{ commands: CommandSpec[] }>;
  /** Run a command's read-only `query` segment. `args` is positional (see CommandModule). Errors → { ok: false, error }. */
  commandQuery(name: string, args: string[], options?: { requestingAgentId?: string }): Promise<CommandResult>;
  /** Run a command's `execute` segment (side effects). `args` is positional. Errors → { ok: false, error }. */
  commandExecute(name: string, args: string[], options?: { requestingAgentId?: string }): Promise<CommandResult>;

  /**
   * Multi-session API (P3+). Each entry in the registry is a SessionRuntime
   * — one chat session = one tree of agents with its own EventBus + ledger
   * namespace. Legacy `emit` / `observeEvents` / `interruptAgents` all route
   * to the "default" session for back-compat. Multi-session callers should
   * use the registry directly.
   */
  readonly sessions: import("../core/session-registry.js").SessionRegistryAPI;
}

export interface InstanceConfig {
  id: string;
  instanceDir: string;
  stateDir: string;
  workerScript?: string;
  /** Template directory used by ensureProvisioned (clone source + dep install). */
  templateDir?: string;
}

// ── Introspection types ──

export interface CapabilityItem {
  name: string;
  path: string;
  size?: number;
}

export interface CapabilityPackageSummary {
  name: string;
  kinds: { tools: string[]; slots: string[]; plugins: string[] };
}

export interface CapabilityLayer {
  id: string;
  packages: CapabilityPackageSummary[];
}

export interface CapabilitiesIntrospection {
  layers: CapabilityLayer[];
  agents: Record<string, { packages: CapabilityPackageSummary[]; config: Record<string, unknown> }>;
}

export interface CapabilityPackageDetail {
  name: string;
  layers: string[];
  items: { tools: CapabilityItem[]; slots: CapabilityItem[]; plugins: CapabilityItem[] };
}

export interface SkillSummary {
  name: string;
  description?: string;
  hasSkillMd: boolean;
}

export interface SkillLayer {
  id: string;
  skills: SkillSummary[];
}

export interface SkillsIntrospection {
  layers: SkillLayer[];
  agents: Record<string, { skills: SkillSummary[] }>;
}

export interface TemplateSummary {
  name: string;
  files: string[];
  hasCapabilities: boolean;
}

export interface TemplateLayer {
  id: string;
  templates: TemplateSummary[];
}

export interface TemplatesIntrospection {
  layers: TemplateLayer[];
}

export interface TemplateDetail {
  name: string;
  agentJson: Record<string, unknown> | null;
  soulMd: string | null;
  principleMd: string | null;
  files: string[];
}

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

/** Local copy of StoredEvent (mirrors media-dir.ts). */
export interface StoredEvent {
  type: string;
  ts: number;
  source?: string;
  to?: string;
  emitterId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}
