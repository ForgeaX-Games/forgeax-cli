/** PathManager — single dispatch point for every framework path.
 *
 *  All path math lives here. No callers should `path.join("~", ".forgeax", ...)`
 *  or read `process.env.FORGEAX_*` directly — they go through the typed layer
 *  APIs (builtin / user / session / agent). This way:
 *    - the source-tree builtin location is fixed once (resolved from
 *      `import.meta.url` at module load)
 *    - the user dir override surface is centralized in `user-dir.ts`
 *    - session/agent paths can never escape their parent tree (sub() guards
 *      against `..` traversal)
 *
 *  Initialization model:
 *    PathManager has no construction-time state besides the user-dir override.
 *    It's a process-singleton so loaders / fs-bridge / agent layer can grab
 *    it without dependency injection plumbing — a single `getPathManager()`
 *    is the runtime equivalent of `import path from "node:path"`. */

import { fileURLToPath } from "node:url";
import { resolve, join, normalize, isAbsolute, dirname, sep } from "node:path";
import type {
  PathManagerAPI,
  BuiltinLayerAPI,
  UserLayerAPI,
  SessionLayerAPI,
  AgentLayerAPI,
  ResourceKind,
} from "./types.js";
import { resolveUserDir } from "./user-dir.js";
import { defaultProjectRoot } from "../api/lib/safe-path.js";

// ─── Builtin root (fixed) ────────────────────────────────────────────────────

/** Resolve the source-tree builtin/ directory.
 *
 *  This file lives at packages/server/runtime/fs/path-manager.ts in the source
 *  tree, so builtin/ is two levels up. Bun and tsc preserve `import.meta.url`
 *  through resolution, so this stays correct without bundling magic.
 *
 *  When the package is consumed via a published bundle (future), this lookup
 *  will need to switch to `require.resolve("@forgeax/server/builtin")`-style
 *  ENOENT-safe probing. We're nowhere near that, so the cwd-style resolution
 *  here is fine. */
function defaultBuiltinRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));        // .../runtime/fs
  return resolve(here, "..", "..", "builtin");                  // .../packages/server/builtin
}

// ─── Layer impls ─────────────────────────────────────────────────────────────

class BuiltinLayer implements BuiltinLayerAPI {
  constructor(private readonly r: string) {}
  root() { return this.r; }
  resourceDir(kind: ResourceKind) { return join(this.r, kind); }
  resourceItem(kind: ResourceKind, name: string) {
    return join(this.r, kind, safeSegment(name));
  }
}

class UserLayer implements UserLayerAPI {
  private readonly _gameRoot: string;
  constructor(private readonly r: string, projectRoot: string) {
    this._gameRoot = resolve(projectRoot, ".forgeax", "games");
  }
  root() { return this.r; }
  keyDir() { return join(this.r, "key"); }
  modelsFile() { return join(this.r, "key", "models.json"); }
  modelsHiddenFile() { return join(this.r, "key", "models-hidden.json"); }
  toolsKeyFile() { return join(this.r, "key", "tools.json"); }
  resourceDir(kind: ResourceKind) { return join(this.r, kind); }
  resourceItem(kind: ResourceKind, name: string) {
    return join(this.r, kind, safeSegment(name));
  }
  sessionsDir() { return join(this.r, "sessions"); }
  gamesDir() { return this._gameRoot; }
  /** Games live instance-local since bug-20260522; rest of UserLayer remains ~/.forgeax. */
  gameDir(slug: string) { return join(this._gameRoot, safeSegment(slug)); }
  globalEventsLog() { return join(this.r, "global-events.jsonl"); }
  cacheDir() { return join(this.r, "cache"); }
  debugLogFile() { return join(this.r, "debug.log"); }
}

class SessionLayer implements SessionLayerAPI {
  private readonly _root: string;
  constructor(private readonly _sid: string, userRoot: string) {
    this._root = join(userRoot, "sessions", safeSegment(_sid));
  }
  sid() { return this._sid; }
  root() { return this._root; }
  configFile() { return join(this._root, "session.json"); }
  agentsDir() { return join(this._root, "agents"); }
  logsDir() { return join(this._root, "logs"); }
  debugLogFile() { return join(this._root, "logs", "debug.log"); }
  latestLogFile() { return join(this._root, "logs", "latest.log"); }
  globalEventsLog() { return join(this._root, "global-events.jsonl"); }
  fileActivityLog() { return join(this._root, "file-activity.jsonl"); }
  resourceDir(kind: ResourceKind) { return join(this._root, kind); }
  resourceItem(kind: ResourceKind, name: string) {
    return join(this._root, kind, safeSegment(name));
  }
  agent(agentPath: string) {
    return new AgentLayer(this.agentsDir(), normalizeAgentPath(agentPath));
  }
}

class AgentLayer implements AgentLayerAPI {
  private readonly _root: string;
  /** _agentPath 是 agentsDir 下的相对路径，原样保留 `/` 分隔。
   *  套娃在物理上由 caller 自己拼："iori/agents/suzu" → `<agentsDir>/iori/agents/suzu/`。 */
  constructor(
    private readonly _agentsDir: string,
    private readonly _agentPath: string,
  ) {
    this._root = join(_agentsDir, _agentPath);
  }
  root() { return this._root; }
  agentJson() { return join(this._root, "agent.json"); }
  agentOverrides() { return join(this._root, "agent-overrides.json"); }
  eventsDir() { return join(this._root, "events"); }
  eventLedgerBlobs() { return join(this._root, "events", "blobs"); }
  resourceDir(kind: ResourceKind) { return join(this._root, kind); }
  resourceItem(kind: ResourceKind, name: string) {
    return join(this._root, kind, safeSegment(name));
  }
  sub(name: string) {
    return new AgentLayer(this._agentsDir, join(this._agentPath, safeSegment(name)));
  }
}

// ─── PathManager ─────────────────────────────────────────────────────────────

class PathManager implements PathManagerAPI {
  private readonly _builtin: BuiltinLayer;
  private readonly _user: UserLayer;

  constructor(opts: { builtinRoot?: string; userRoot?: string; projectRoot?: string } = {}) {
    this._builtin = new BuiltinLayer(resolve(opts.builtinRoot ?? defaultBuiltinRoot()));
    this._user = new UserLayer(
      resolve(opts.userRoot ?? resolveUserDir()),
      resolve(opts.projectRoot ?? defaultProjectRoot()),
    );
  }

  builtin(): BuiltinLayerAPI { return this._builtin; }
  user(): UserLayerAPI { return this._user; }
  session(sid: string): SessionLayerAPI {
    return new SessionLayer(sid, this._user.root());
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: PathManager | null = null;

export function initPathManager(opts?: { builtinRoot?: string; userRoot?: string; projectRoot?: string }): PathManager {
  _instance = new PathManager(opts);
  return _instance;
}

export function getPathManager(): PathManager {
  if (!_instance) _instance = new PathManager();
  return _instance;
}

/** Test-only — replace the singleton without re-instantiating callers. */
export function resetPathManager(): void {
  _instance = null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Reject path segments that would escape their parent (slashes, `..`, abs).
 *  Loaders accept user-provided names (slug / agent name / kit id) — this is
 *  the cheap defense against directory traversal. */
function safeSegment(name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name === ".." || isAbsolute(name)) {
    throw new Error(`PathManager: unsafe path segment ${JSON.stringify(name)}`);
  }
  return name;
}

/** Normalize an agent path like "iori/agents/suzu" — accepts `/` separators only,
 *  forbids absolute / parent traversal. 套娃形态由 caller 显式带 "agents/" 段。 */
function normalizeAgentPath(raw: string): string {
  if (!raw) throw new Error("PathManager: agent path may not be empty");
  if (isAbsolute(raw) || raw.includes("\\")) {
    throw new Error(`PathManager: agent path must be relative POSIX-style: ${JSON.stringify(raw)}`);
  }
  const norm = normalize(raw);
  if (norm.startsWith("..") || norm.split("/").includes("..")) {
    throw new Error(`PathManager: agent path may not traverse upward: ${JSON.stringify(raw)}`);
  }
  return norm.split(sep).join("/");
}
