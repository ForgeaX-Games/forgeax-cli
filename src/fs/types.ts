/** PathManager type contracts.
 *
 *  Mirrors the v3 5-layer architecture (see docs/features/runtime-rewrite-feature-map.md):
 *    - builtin  → source tree, packages/server/builtin/<resource>/
 *    - user     → ~/.forgeax/                                (renamed from agenteam state-dir)
 *    - session  → ~/.forgeax/sessions/<sid>/
 *    - agent    → ~/.forgeax/sessions/<sid>/<agent-path>/
 *
 *  PathManager owns the *index* — no I/O, no caching, just path resolution.
 *  Loaders read file contents through these paths; FSWatcher subscribes to
 *  them. There is exactly one builtin path tree (fixed at source location)
 *  and exactly one user dir (env-overrideable). Sessions and agents are
 *  parameterized by id / sub-path. */

export type ResourceKind = "agent-templates" | "tree-templates" | "kits" | "commands";

/** Source tree (builtin) — fixed location relative to the runtime package. */
export interface BuiltinLayerAPI {
  root(): string;
  resourceDir(kind: ResourceKind): string;
  resourceItem(kind: ResourceKind, name: string): string;
}

/** User-level data root — `~/.forgeax/` by default, override via `FORGEAX_USER_DIR`. */
export interface UserLayerAPI {
  root(): string;

  // Key files (single dispatch — no scattered joins). llm_key.json was
  // retired 2026-05 — credentials moved to $ROOT/.env, routing to
  // src/llm/auto-resolver.ts.
  keyDir(): string;
  modelsFile(): string;          // ~/.forgeax/key/models.json
  /** Per-model "hide from picker" overrides — { hidden: string[] }. Out of
   *  band from models.json so live-only ids that aren't in the disk catalog
   *  can still be toggled without inventing a stub spec. */
  modelsHiddenFile(): string;    // ~/.forgeax/key/models-hidden.json
  toolsKeyFile(): string;        // ~/.forgeax/key/tools.json

  // Resource roots (4-layer overlay layer 2).
  resourceDir(kind: ResourceKind): string;
  resourceItem(kind: ResourceKind, name: string): string;

  // Session + game-project roots.
  sessionsDir(): string;
  gamesDir(): string;
  gameDir(slug: string): string;

  // Cross-session artifacts.
  globalEventsLog(): string;
  cacheDir(): string;

  // SessionManager-singleton logger 落点。Append-only，size-rotate。
  debugLogFile(): string;        // ~/.forgeax/debug.log
}

/** Session layer — one per `<sid>`. */
export interface SessionLayerAPI {
  sid(): string;
  root(): string;
  configFile(): string;                        // session.json
  agentsDir(): string;                         // <sid>/agents/

  // Per-session logger 落点。debug.log = append + size-rotate，latest.log =
  // truncate-on-construct（本次进程的 INFO+ 全量，方便 `tail -f`）。
  logsDir(): string;                           // <sid>/logs/
  debugLogFile(): string;                      // <sid>/logs/debug.log
  latestLogFile(): string;                     // <sid>/logs/latest.log

  /** Per-session "headless" event sink —— 镜像 agenteam ref `system-event-log.ts`：
   *  emitterId == null && event.to == null && !type.startsWith("stream:") 的事件
   *  落到这里（agent_added / agent_removed / default_dir_changed /
   *  partial_boundary / compact_boundary 等 session 级广播）。每条 JSONL，append-only。 */
  globalEventsLog(): string;                   // <sid>/global-events.jsonl

  /** Per-session file-activity ledger —— 每条 JSONL 一行：
   *  `{ ts, agentPath, op, path, fromPath?, bytes?, hash?, isCreate }`。
   *  SSOT 路径，AgentsPanel / LLM slot / `/api/sessions/:sid/file-activity`
   *  全都从这一份盘上数据 derive。append-only，跟 globalEventsLog 平行。 */
  fileActivityLog(): string;                   // <sid>/file-activity.jsonl

  resourceDir(kind: ResourceKind): string;     // session-level override (kits only typically)
  resourceItem(kind: ResourceKind, name: string): string;
  /** Agent path within this session, eg "iori", "iori/suzu". 物理落在 `<sid>/agents/<path>/`。 */
  agent(agentPath: string): AgentLayerAPI;
}

/** Agent layer — one per node in the agent tree. */
export interface AgentLayerAPI {
  root(): string;
  agentJson(): string;
  /** Per-agent overrides written by `mergeDefaults` of kit's condition.ts;
   *  deep-merged onto agent.json at load time but never overwrites it. */
  agentOverrides(): string;                    // agent-overrides.json
  eventsDir(): string;                         // events/ — 装 events-N.jsonl + blobs/
  eventLedgerBlobs(): string;                  // events/blobs/
  resourceDir(kind: ResourceKind): string;     // agent-level override (kits only typically)
  resourceItem(kind: ResourceKind, name: string): string;
  /** Resolve sub-agent without escaping the tree. */
  sub(name: string): AgentLayerAPI;
}

export interface PathManagerAPI {
  builtin(): BuiltinLayerAPI;
  user(): UserLayerAPI;
  session(sid: string): SessionLayerAPI;
}

// ─── FSWatcher ───────────────────────────────────────────────────────────────

export interface WatchRegistration {
  id: string;
  dispose(): void;
}

export interface FSChangeEvent {
  type: "create" | "modify" | "delete" | "rename";
  path: string;
  isDir: boolean;
}

export type FSHandler = (event: FSChangeEvent) => void | Promise<void>;

export interface FSWatcherAPI {
  /** Watch a single file. Internally watches the parent dir (non-recursive) +
   *  filters by basename, so atomic-rename writes still fire. */
  watchFile(absPath: string, handler: () => void, opts?: { debounceMs?: number; ownerId?: string }): WatchRegistration;
  /** Watch a directory recursively. `handler.path` is relative to `absPath`. */
  watchDir(absPath: string, handler: FSHandler, opts?: { debounceMs?: number; ownerId?: string; pattern?: RegExp }): WatchRegistration;
  unregisterOwner(ownerId: string): void;
  close(): void;
}
