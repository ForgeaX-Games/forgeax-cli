import { resolve, join, normalize, isAbsolute } from "node:path";
import type {
  SharedLayerAPI,
  InstanceLayerAPI,
  TeamLayerAPI,
  AgentLayerAPI,
  PathManagerAPI,
} from "../core/types.js";
import { getSharedPaths } from "./state-dir.js";

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: PathManager | null = null;

export function initPathManager(projectRoot: string, stateDir?: string): PathManager {
  if (_instance) throw new Error("PathManager already initialized — singleton cannot be re-initialized.");
  if (stateDir) getSharedPaths(stateDir);
  _instance = new PathManager(projectRoot);
  return _instance;
}

export function getPathManager(): PathManager {
  if (!_instance) throw new Error("PathManager not initialized — call initPathManager() first.");
  return _instance;
}

// ─── Layer implementations ───────────────────────────────────────────────────

class InstanceLayer implements InstanceLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  debugLog() { return join(this.r, "debug.log"); }
  capabilitiesDir() { return join(this.r, "capabilities"); }
  templatesDir() { return join(this.r, "templates"); }
  commandsDir() { return join(this.r, "commands"); }
  backupsDir() { return join(this.r, "backups"); }
  containersRegistry() { return join(this.r, "containers.list"); }
  mountsConfig() { return join(this.r, "mounts.json"); }
}

class TeamLayer implements TeamLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  capabilitiesDir() { return join(this.r, "capabilities"); }
  templatesDir() { return join(this.r, "templates"); }
  commandsDir() { return join(this.r, "commands"); }
  logsDir(agentId?: string) {
    const base = join(this.r, "logs");
    return agentId ? join(base, agentId) : base;
  }
  terminalsDir(agentId?: string) {
    const base = join(this.r, "terminals");
    return agentId ? join(base, agentId) : base;
  }
  agentsDir() { return join(this.r, "agents"); }

  manifest() { return join(this.r, "manifest.json"); }
  envDir() { return join(this.r, "env"); }
  sharedWorkspace() { return join(this.r, "shared-workspace"); }

  homeFor(agentId: string) { return join(this.r, "homes", agentId); }
  /** Pre-session-isolation legacy root for un-scoped ledgers (instance-global,
   *  one folder per agentId). Kept for callers that have no sessionId in hand;
   *  prefer ledgersFor(agentId, sessionId) when you do. */
  agentLedgersDir() { return join(this.r, "agent-ledgers"); }
  /**
   * Resolve the ledger root for one agent.
   *  - sessionId provided → `sessions/<sid>/<agentId>/` (P2+ canonical path)
   *  - sessionId omitted   → `agent-ledgers/<agentId>/` (legacy, pre-session)
   *
   * P2 boundary: AgentLedger always constructs with sessionId now, so any
   * new caller without an id is by definition reading the legacy bucket.
   */
  ledgersFor(agentId: string, sessionId?: string | null): string {
    if (sessionId) return join(this.r, "sessions", sessionId, agentId);
    return join(this.r, "agent-ledgers", agentId);
  }
  /** Per-session root (`sessions/<sid>/`) — owns all ledgers + future per-session state. */
  sessionDir(sessionId: string) { return join(this.r, "sessions", sessionId); }
  /** Root of all session dirs — `sessions/`. Used for listing / cleanup. */
  sessionsRootDir() { return join(this.r, "sessions"); }
  agentTree() { return join(this.r, "agents", "agent-tree.json"); }
  teamBoard() { return join(this.r, "shared-workspace", "teamboard.json"); }
}

class AgentLayer implements AgentLayerAPI {
  constructor(private readonly r: string, private readonly home: string) {}

  root() { return this.r; }
  capabilitiesDir() { return join(this.r, "capabilities"); }
  templatesDir() { return join(this.r, "templates"); }

  config() { return join(this.r, "agent.json"); }
  configOverrides() { return join(this.home, "agent-overrides.json"); }
  soul() { return join(this.r, "SOUL.md"); }
  principleFile() { return join(this.r, "PRINCIPLE.md"); }
  envFile() { return join(this.r, ".env"); }
}

// ─── PathManager ─────────────────────────────────────────────────────────────

export class PathManager implements PathManagerAPI {
  private readonly _root: string;
  private readonly _instance: InstanceLayer;
  private readonly _team: TeamLayer;

  constructor(instanceRoot: string) {
    this._root = resolve(instanceRoot);
    this._instance = new InstanceLayer(this._root);
    this._team = new TeamLayer(join(this._root, "team"));
  }

  root() { return this._root; }
  /** Delegates to the standalone getSharedPaths() — PathManager does not own this layer. */
  shared(): SharedLayerAPI { return getSharedPaths(); }
  instance(): InstanceLayerAPI { return this._instance; }
  team(): TeamLayerAPI { return this._team; }

  agent(agentId: string): AgentLayerAPI {
    return new AgentLayer(
      join(this._team.agentsDir(), agentId),
      this._team.homeFor(agentId),
    );
  }

  packDir(packId: string) { return join(getSharedPaths().packsDir(), packId); }
  backupDir(backupId: string) { return join(this._root, "backups", backupId); }

  resolve(input: { path: string; agent?: string }, callerAgentId: string): string {
    const raw = input.path;
    if (isAbsolute(raw)) return normalize(raw);
    return resolve(this._team.homeFor(input.agent ?? callerAgentId), raw);
  }
}
