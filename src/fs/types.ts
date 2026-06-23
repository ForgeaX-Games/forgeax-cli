/** Filesystem types — PathManager layer APIs, FSWatcher. */

// ─── PathManager 分层接口 ─────────────────────────────────────────────────────
//
// 三层模型（优先级：agent > team > instance）：
//   instance()        — Instance 根目录（~/.agenteam/instances/{id}/），包含全量日志、备份、公共能力
//   team()            — team/ 层，当前活跃 team 的运行时空间
//   agent(agentId)    — team/agents/{id}/ 层，单个 agent 的模板定义
//
// 运行时路径（homes/agent-ledgers/logs/terminals/medias）归 TeamLayer。
// AgentLayer 只负责模板定义（config/soul/principle/capabilities/env）。
//
// 用法示例：
//   pathManager.instance().capabilitiesDir()              → capabilities/
//   pathManager.instance().debugLog()                     → debug.log
//   pathManager.team().agentsDir()                        → team/agents/
//   pathManager.team().sharedWorkspace()                  → team/shared-workspace/
//   pathManager.team().homeFor("coder")                   → team/homes/coder/
//   pathManager.team().ledgersFor("coder")                → team/agent-ledgers/coder/
//   pathManager.agent("coder").capabilitiesDir()          → team/agents/coder/capabilities/
//   pathManager.agent("coder").root()                     → team/agents/coder/

/** 三层共享的能力目录访问接口 */
export interface CapabilityLayerAPI {
  /** capabilities/ — package-based capability directory */
  capabilitiesDir(): string;
  /** templates/ — agent template directory */
  templatesDir(): string;
}

/** Shared 层：~/.agenteam，Gateway 级共享目录 */
export interface SharedLayerAPI {
  root(): string;
  keyDir(): string;
  /** key/tools.json — 工具级 API 密钥 */
  toolsKey(): string;
  packsDir(): string;
  gatewayConfig(): string;
  /** gateway.log — Gateway 层日志 */
  gatewayLog(): string;
  /** instances/ — 所有 Instance 运行时目录的父目录 */
  instancesDir(): string;
  /** instances/{instanceId}/ — 单个 Instance 运行时目录 */
  instanceDir(instanceId: string): string;
  /** agenteam.json — 全局共享配置 */
  agenteamConfig(): string;
  /** cache/ — 通用适配器缓存根目录 */
  cacheDir(): string;
  /** cache/{adapterName}/ — 特定适配器的缓存目录 */
  adapterCache(adapterName: string): string;
}

/** Instance 层：~/.agenteam/instances/{id}/，Instance 根目录 */
export interface InstanceLayerAPI extends CapabilityLayerAPI {
  root(): string;
  /** debug.log — Instance 全量日志（instance → teamManager → scheduler → agent） */
  debugLog(): string;
  backupsDir(): string;
  containersRegistry(): string;
  /** instances/{id}/mounts.json — SSHFS mount configuration (instance-level, only evolve mode can write) */
  mountsConfig(): string;
  /** commands/ — instance-layer worker command modules (pack-shared) */
  commandsDir(): string;
}

/** Team 层：team/ 运行时，当前活跃 team 的可写空间 */
export interface TeamLayerAPI extends CapabilityLayerAPI {
  /** team/ */
  root(): string;
  /** team/logs/ or team/logs/{agentId}/ */
  logsDir(agentId?: string): string;
  /** team/terminals/ or team/terminals/{agentId}/ */
  terminalsDir(agentId?: string): string;
  /** team/agents/ */
  agentsDir(): string;
  /** team/manifest.json */
  manifest(): string;
  /** team/env/ */
  envDir(): string;
  /** team/shared-workspace/ */
  sharedWorkspace(): string;
  /** team/homes/{agentId}/ — agent 的运行时 $HOME */
  homeFor(agentId: string): string;
  /** 旧的 instance-global ledger 根目录(pre-session)。新代码用 ledgersFor + sessionId。 */
  agentLedgersDir(): string;
  /**
   * 一个 agent 的 ledger 根目录。
   *  - 带 sessionId: team/sessions/{sid}/{agentId}/
   *  - 不带:        team/agent-ledgers/{agentId}/ (legacy)
   */
  ledgersFor(agentId: string, sessionId?: string | null): string;
  /** team/sessions/{sid}/ — single session root, owns all per-session state. */
  sessionDir(sessionId: string): string;
  /** team/sessions/ — root of all per-session dirs. */
  sessionsRootDir(): string;
  /** team/agents/agent-tree.json — agent 拓扑结构持久化 */
  agentTree(): string;
  /** team/shared-workspace/teamboard.json — 响应式状态注册表 */
  teamBoard(): string;
  /** team/commands/ — team-layer worker command modules (team-private, overrides instance layer on name conflict) */
  commandsDir(): string;
}

/** AgentLayer：team/agents/{agentId}/，单个 agent 的模板定义 */
export interface AgentLayerAPI extends CapabilityLayerAPI {
  /** team/agents/{agentId}/ */
  root(): string;
  /** team/agents/{agentId}/agent.json — pack 拥有的声明式配置 */
  config(): string;
  /** team/homes/{agentId}/agent-overrides.json — 用户/运行时覆盖层 */
  configOverrides(): string;
  /** team/agents/{agentId}/SOUL.md */
  soul(): string;
  /** team/agents/{agentId}/PRINCIPLE.md */
  principleFile(): string;
  /** team/agents/{agentId}/.env */
  envFile(): string;
}

export interface PathManagerAPI {
  /** Instance 根目录（~/.agenteam/instances/{id}/） */
  root(): string;
  /** Shared 层（~/.agenteam — 密钥、packs 等 Gateway 级共享） */
  shared(): SharedLayerAPI;
  /** Instance 层（debug.log、capabilities/ 等 Instance 级目录） */
  instance(): InstanceLayerAPI;
  /** Team 层（运行时目录：homes/ sessions/ logs/ terminals/ medias/ env/ shared-workspace/） */
  team(): TeamLayerAPI;
  /** AgentLayer（team/agents/{agentId}/ 模板定义：config/soul/principle/capabilities） */
  agent(agentId: string): AgentLayerAPI;
  /** packs/{packId}/ */
  packDir(packId: string): string;
  /** backups/{backupId}/ */
  backupDir(backupId: string): string;
  /**
   * 将相对路径解析为特定 agent 的 homes/{id}/ 下的绝对路径。
   * 如果输入的是绝对路径，则返回该绝对路径本身。
   */
  resolve(input: { path: string; agent?: string }, callerAgentId: string): string;
}

// ─── FSWatcher ───

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
  /**
   * Watch a single file. `handler` is called on any change to that file.
   * Internally watches the parent directory (non-recursive) and filters by
   * basename, so atomic-rename writes (create-temp + rename) still fire.
   */
  watchFile(absPath: string, handler: () => void, opts?: { debounceMs?: number; ownerId?: string }): WatchRegistration;

  /**
   * Watch a directory recursively. `handler` receives FSChangeEvent whose
   * `path` is relative to `absPath` (the watched directory). Optional
   * `pattern` pre-filters events at dispatch time (does NOT change which
   * inotify watches are installed — all subscribers under the same absPath
   * share one underlying recursive watch).
   */
  watchDir(absPath: string, handler: FSHandler, opts?: { debounceMs?: number; ownerId?: string; pattern?: RegExp }): WatchRegistration;

  unregisterOwner(ownerId: string): void;
  close(): void;
}
