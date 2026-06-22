/** Core public primitives — imported by tools/, plugins/, slots/ */

// Types re-imported from domain modules for in-file use; re-exported at bottom.
import type {
  PathManagerAPI,
  FSWatcherAPI,
} from "../fs/types.js";

// ─── Event System ───

export type EventHandoff = "silent" | "passive" | "turn" | "innerLoop" | "steer";

export interface ContentPayload {
  content: EventContent;
  [key: string]: unknown;
}

export interface EventPayload {
  /** Event-level content for display / logging — `string | ContentPart[]`.
   *  NOT directly fed to LLM. For LLM prompt, use `llmMessage`. */
  content?: EventContent;
  /** Human/AI-readable display text for files & UI. */
  visual_display?: string;
  /** Materialized LLM message(s) — agent layer attaches this after processing
   *  (materializeAssistantMessage, prepareInboundMessages, etc.).
   *  Ledger extracts this into in-memory messages[] for prompt building. */
  llmMessage?: import("../llm/types.js").LLMMessage | import("../llm/types.js").LLMMessage[];

  /** Present → renderer shows red error, highest display priority. */
  error?: string;
  /** Present → renderer shows yellow warning, second priority. */
  warning?: string;

  [key: string]: unknown;
}

export interface EventBase {
  source: string;       // e.g. "user", "heartbeat", "hook:TurnEnd"
  type: string;         // e.g. "message", "tick", "block_break"
  payload: EventPayload;
  ts: number;

  priority?: number;    // 0=immediate, 1=normal(default), 2=low

  // ── Cancelable hook (present on hook events created by createHookEvent) ──
  block?: (reason?: string) => void;
  isBlocked?: () => boolean;
  blockReason?: string;
}

// handoff is only meaningful when routing to a queue (i.e. `to` is set).
// TypeScript enforces: you cannot set handoff without to.
export type Event = EventBase & (
  | { to: string; handoff?: EventHandoff }   // routed: agentId, "*" broadcast
  | { to?: undefined; handoff?: undefined }   // observers-only (publish)
);

/** Event payload for emitToSelf / plugin emit — `to` is auto-filled by the bus. */
export type SelfEvent = EventBase & { handoff?: EventHandoff };

export interface EventQueueInterface {
  push(event: Event): void;
  drain(filter?: (event: Event) => boolean): Event[];
  pending(): number;
  hasHandoff(handoff: EventHandoff): boolean;
  onSteer(cb: () => void): { dispose(): void };
}

/** Agent-bound EventBus facade exposed to tools and plugins.
 *  publish()  — notify observers only, no queue routing (lifecycle hooks, announcements).
 *  emit()     — notify observers + route via event.to, broadcast auto-excludes self.
 *  hook()     — shorthand publish for typed hook events (auto-fills source + ts). */
export interface EventBusAPI {
  publish(event: Event, emitterId?: string): void;
  emit(event: Event, emitterId?: string): void;
  /** Emit an event that routes back to this agent's own queue. `to` is auto-filled. */
  emitToSelf(event: SelfEvent): void;
  /** Publish a hook event — observers only, source and ts auto-filled.
   *  Returns the HookEvent so callers can check isBlocked() after publish. */
  hook(type: string, payload: EventPayload): import("../hooks/types.js").HookEvent;
  observe(handler: (event: Event, emitterId?: string) => void): () => void;
  /** Observe only events from a specific agent (filtered by emitterId). */
  observeAgent(agentId: string, handler: (event: Event) => void): () => void;
}

// ─── Multimodal Content ───
//
// 4 modalities (text / image / audio / video), each with two storage forms:
//   inline  — data in memory   (text / image / audio / video)
//   file    — path on disk     (text_file / image_file / audio_file / video_file)
// Inline media (image/video/audio with base64 data) is externalized to disk at WAL
// write time by EventLedger, converting to *_file path references. At LLM consumption
// time, small *_file refs (<=1MB) are re-inlined by media-preflight.
// "file" is a generic fallback for unknown/binary files (e.g. PDF); providers decide
// individually how to handle them (native document support, File API, or placeholder).

export type ContentPart =
  | {
      type: "text";
      text: string;
    }
  | { type: "text_file"; path: string; mimeType: string; inContainer?: boolean }
  | { type: "file"; path: string; mimeType: string; inContainer?: boolean }
  | { type: "image"; data: string; mimeType: string; name?: string }
  | { type: "video"; data: string; mimeType: string; name?: string }
  | { type: "audio"; data: string; mimeType: string; name?: string }
  | { type: "image_file"; path: string; mimeType: string; inContainer?: boolean }
  | { type: "video_file"; path: string; mimeType: string; inContainer?: boolean }
  | { type: "audio_file"; path: string; mimeType: string; inContainer?: boolean };

export type EventContent = string | ContentPart[];
export type InlineMediaContentPart = Extract<ContentPart, { type: "image" | "video" | "audio" }>;

/**
 * Media content referenced by path (image_file / video_file / audio_file).
 *
 * ## Path ownership marker (`inContainer`)
 *
 * Explicit producer-side contract about where `path` lives.
 *
 * - `inContainer: true | undefined` (default) — path lives in the sandbox
 *   container's view. Consumers read via `sandboxFs`, which routes through
 *   bind-mount (fast, host-side readFile) when the path is under the instance
 *   root, and through docker exec otherwise. Tool producers running inside
 *   the container's namespace (e.g. `read_file` reading `/tmp/foo.png`) get
 *   this for free — they don't have to set anything.
 *
 * - `inContainer: false` — path is a pure host path, unreachable from inside
 *   the container. Consumers skip the bridge and read via `node:fs` directly.
 *   Set this explicitly when producing a part whose path originates outside
 *   the container world — user-supplied host files (ink-renderer paste),
 *   channel-side caches (WeChat attachment download), etc.
 *
 * ## Host-side consumer
 *
 * `readMediaBytes` (`src/llm/media-storage.ts`) is the single dispatch point —
 * everything downstream (anthropic / openai / gemini provider adapters) shares
 * it. Adding a new consumer means adding one more branch here, never a
 * fallback on top.
 */
export type FileMediaContentPart = Extract<ContentPart, { type: "image_file" | "video_file" | "audio_file" }>;

export type MediaContentPart = InlineMediaContentPart | FileMediaContentPart;

// ─── Content utility functions (canonical definitions in content-utils.ts) ───

export {
  isMediaContentPart,
  isInlineMediaContentPart,
  isFileMediaContentPart,
  isContentPayload,
  isBinaryBuffer,
  isBinaryFile,
  fileToContentPart,
} from "./content-utils.js";

// ─── Model Spec ───

export type InputModality = "text" | "image" | "video" | "audio";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSpec {
  input: InputModality[];
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  defaultTemperature: number;
}

// ─── Agent Config ───

export interface CapabilitiesConfig {
  /** Layer switches — whether to load from the global / team capability layers. */
  global?: "all" | "none";
  team?: "all" | "none";

  /**
   * Enable/disable capabilities. Processed in order: enable first, then disable.
   * Supported token formats:
   *   "name"              — bare capability name (e.g. "read_file")
   *   "#package"          — all capabilities in a package (e.g. "#agent_manage")
   *   "package/kind/name" — fully qualified (e.g. "workspace_read/tools/read_file")
   *   "package/kind/*"    — wildcard within package
   */
  enable?: string[];
  disable?: string[];

  /** Per-capability runtime config, keyed by package then capability name. */
  config?: Record<string, Record<string, Record<string, unknown>>>;
}

export interface CapabilitySource {
  id: string;
  dir: string;
}

export interface CapabilityDescriptor {
  name: string;
  /** Capability package directory name (e.g. "workspace_read"). */
  pkg?: string;
  /** Capability kind within the package. */
  kind?: "tools" | "slots" | "plugins";
  path: string;
  /** Source layer this descriptor was scanned from (e.g. "instance", "team", or agentId). */
  layer: "instance" | "team" | string;
}

export interface ModelsConfig {
  /** 模型名称，可以是单个或数组（fallback 链）。null 表示继承上级配置。 */
  model?: string | string[] | null;
  /** Per-agent model routing policy. Runtime hints are in-memory only. */
  routing?: {
    stickiness?: {
      /** Enable short-lived affinity to the last successful model in the fallback chain. */
      enabled?: boolean;
      /** Lease duration for the successful model. Defaults to Anthropic's 5m cache TTL. */
      ttlMs?: number;
      /** Cooldown applied to a model that triggered fallback. */
      cooldownMs?: number;
    };
  };
  /** 温度。null 表示继承上级 / 使用 provider 默认值。 */
  temperature?: number | null;
  /** 最大输出 token 数。null 表示继承上级 / 使用 provider 默认值。 */
  maxTokens?: number | null;
  /** 推理强度。null 表示继承上级。 */
  reasoningEffort?: ReasoningEffort | null;
  /** 是否显示思考过程 */
  showThinking?: boolean;
  /** 降级链最大重试轮数（每轮依次尝试所有模型各一次），默认 5 */
  maxRetries?: number;
  /** 基础重试延迟（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 最大重试延迟（毫秒），默认 30000 */
  maxDelayMs?: number;
  /** LLM 调用超时（毫秒），-1 = 永不超时，默认 -1 */
  timeout?: number;
}

export interface AgentJson {
  /** LLM 模型配置 */
  models?: ModelsConfig;

  /** 事件合并窗口（毫秒），默认 300 */
  coalesceMs?: number;

  /** 单轮最大 LLM 调用次数，默认 200 */
  maxIterations?: number;

  /** 能力配置 */
  capabilities?: CapabilitiesConfig;

  /** Session 压缩配置 (microCompact — global idle-gap gate) */
  session?: {
    /** 保留最近 N 个 tool_result 不压缩（默认 20）。压缩仅在 agent idle 越过 idleGapMs 时触发；触发后保护区外全部清空为固定占位文本。 */
    keepRecentTools?: number;
    /** 保留最近 N 个含媒体（图/音/视/文件）的消息不压缩（默认 2）。同样仅在 idle 触发时生效。 */
    keepRecentMedias?: number;
    /**
     * Idle-gap 阈值 (ms)：仅当 `Date.now() - LAST_USER_INPUT_AT >= idleGapMs` 时才执行压缩，否则历史按字节原样返回。
     *
     * 默认 20 分钟。所有 provider 的 prefix cache（Anthropic ephemeral 5min、OpenAI/DeepSeek、Gemini）
     * 都已在此前过期，所以压缩只发生在缓存"已经凉了"的窗口内 — 永远不会破坏一个还活着的缓存。
     */
    idleGapMs?: number;
  };


  /** 时区，默认 Asia/Shanghai */
  timezone?: string;

  /**
   * 默认工作目录（相对路径以 homes/{id}/ 为基准，或绝对路径）。
   * 不设置时默认为 team/homes/{id}/。
   * 设置后作为 CURRENT_DIR 初始值；运行时 shell cd 会自动更新 CURRENT_DIR。
   */
  defaultDir?: string;

  /**
   * 当 TeamBoard STATUS 键不存在时的默认值。
   * 默认为 ""（空字符串）。
   */
  defaultStatus?: string;
}

export interface AgentTeamConfig {
  /** 全局模型配置 */
  models?: ModelsConfig;
  /** Docker 沙箱配置 */
  sandbox?: {
    sshKeyPath?: string;
    /** 宿主机 sshd 端口（供容器 SSHFS 回连），由 start.sh detect_sshd_port 探测并回写，默认 22。 */
    sshPort?: number;
  };
}

// ─── Agent Tree (topology + roles) ───
//
// AgentRole is assigned at creation time and persisted in StoredNode.
// Default assignment (when not explicitly declared):
//   - admin   → first root node (no other roots exist yet)
//   - steward → additional root nodes
//   - worker  → child nodes (non-root)
// Once assigned, role does NOT change on topology mutations (attach/detach).
// Completely decoupled from brain type (ConsciousAgent / ScriptAgent).

export type AgentRole = "admin" | "steward" | "worker";

export interface AgentNodeData {
  id: string;
  /** Assigned at creation time and persisted — does not change on topology mutations. */
  readonly role: AgentRole;
  parentId: string | null;
  childIds: string[];
  /** Static grouping tags for task eligibility / agent filtering. */
  groups: string[];
  spawnedAt: number;
}

export interface CreateAgentParams {
  id: string;
  parentId?: string | null;
  /** Explicit role. When omitted, auto-assigned based on creation context. */
  role?: AgentRole;
  /** Template name (e.g. "subagent/observe"). Resolved across instance → team → agent layers. */
  template?: string;
  /** When set, tree lifecycle events are attributed to this agent's ledger. */
  emitterId?: string;
  /** Non-destructively copy parent's agent dir contents into the new agent. */
  fillFromParent?: boolean;
  /** Deep-merge parent's agent.json into the new agent's (current wins on conflicts). */
  mergeParentAgentJson?: boolean;
  /** Scaffold hint: "conscious" (default) or "script" (scaffolds src/index.ts). Omit = "conscious". */
  agentType?: "conscious" | "script";
}

export interface SyncFromDiskResult {
  added: string[];
  removed: string[];
  all: string[];
}

export interface AgentTreeCallbacks {
  onAgentCreated?: (id: string) => void | Promise<void>;
  onAgentFreed?: (id: string) => void | Promise<void>;
}

/** Recursive tree-view node returned by view(). */
export interface AgentTreeNode {
  node: AgentNodeData;
  children: AgentTreeNode[];
}

/** Agent-visible tree interface — query topology + mutate nodes. */
export interface AgentTreeAPI {
  getNode(id: string): AgentNodeData | null;
  getParent(id: string): AgentNodeData | null;
  getChildren(id: string): AgentNodeData[];
  getAncestors(id: string): AgentNodeData[];
  getDescendants(id: string): AgentNodeData[];
  allNodes(): AgentNodeData[];
  /** All root-level nodes (parentId === null). */
  roots(): AgentNodeData[];
  has(id: string): boolean;
  /** Persisted role for a given agent. */
  roleOf(id: string): AgentRole | null;
  /** All nodes matching the given role. */
  getByRole(role: AgentRole): AgentNodeData[];

  /** Build a recursive subtree rooted at the given agent.
   *  depth controls truncation (undefined = unlimited, 0 = node only). */
  view(rootId: string, depth?: number): AgentTreeNode | null;

  attach(node: Omit<AgentNodeData, "childIds" | "role" | "groups">, parentId: string | null): void;
  /** Detach a node from its current parent — the node becomes a root. Does NOT remove from tree. */
  detach(id: string): void;
  updateRole(id: string, role: AgentRole): void;
  /** Move a node to a new parent (or root). Children follow the node. Throws on cycle. */
  reparent(id: string, newParentId: string | null): void;
  /** Set an agent's groups (replaces entire array). */
  updateGroups(id: string, groups: string[]): void;
  /** All agents belonging to the given group. */
  getGroupMembers(group: string): AgentNodeData[];
  /** Groups the given agent belongs to. */
  getAgentGroups(id: string): string[];

  /**
   * Compute tree-derived writable paths for an agent (real-time, no storage).
   * Returns relative paths under team/ that the agent may write to based on
   * tree topology alone (self dirs, direct children dirs, shared-workspace).
   */
  getWritablePaths(agentId: string): string[];

  /** Scaffold agent directory + attach node to tree. */
  create(params: CreateAgentParams): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Detach + remove agent directory from disk. Children promoted to root. */
  free(id: string, emitterId?: string): Promise<void>;
}

/** Scheduler-only tree management — extends AgentTreeAPI with lifecycle methods. */
export interface AgentTreeManagerAPI extends AgentTreeAPI {
  /** Scan agents/ directory, attach missing nodes, detach orphans. */
  syncFromDisk(): Promise<SyncFromDiskResult>;
  loadFromDisk(): void;
  /** Register both agent-tree.json hot-reload and team/agents/ directory watching. */
  startWatching(watcher: FSWatcherAPI, callbacks?: AgentTreeCallbacks): void;
  /** Unregister all FS watches owned by AgentTree. */
  stopWatching(): void;
}

// ─── Capability Base ───

/** Shared meta-properties for all capability types (slot / tool / plugin). */
export interface CapabilityBase {
  name: string;
  description?: string;
  /** Runtime visibility predicate — return false to hide this capability for the current turn.
   *  The framework passes the capability instance itself as the second argument. */
  condition?: (ctx: AgentContext, self?: CapabilityBase) => boolean;
}

// ─── Tool System ───

export type ToolOutput = string | ContentPart[];

export interface ToolDefinition extends CapabilityBase {
  name: string;
  description: string;
  /** Per-model LLM schema visibility predicate.  When set, the provider wrapper
   *  includes this tool only for attempts whose catalog model name passes the check
   *  (model argument is before `@key`).  Evaluated after `condition`, so
   *  `condition` remains the general gate. */
  modelFilter?: (model: string) => boolean;
  /** Behavioral guidance injected into the system prompt via the tools slot. */
  guidance?: string;
  ccVersion?: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  /** Optional pre-execution validation. Return an error string to reject, or undefined to proceed. */
  validateInput?: (args: Record<string, unknown>, ctx: AgentContext) => string | undefined | Promise<string | undefined>;
  execute: (args: Record<string, unknown>, ctx: AgentContext) => Promise<ToolOutput>;
  /** Optional: produce a human-readable summary for the renderer. Auto-called by framework. */
  formatDisplay?: (args: Record<string, unknown>, result: ToolOutput) => string;
  /** Max chars for the string result before truncation. Default: 256000. Set Infinity to disable. */
  maxResultChars?: number;
  /**
   * Optional per-tool compaction strategy for microCompact.
   *
   * When the idle-gap gate fires and this tool's result falls outside the
   * protection zone:
   *   - If `compactResult` is defined → its return value replaces the content.
   *     Return the original `result` unchanged to preserve the result as-is.
   *     Return `null` to skip compaction for this particular invocation.
   *   - If `compactResult` is NOT defined → result is cleared to a fixed
   *     placeholder `[Old tool result content cleared]` (default behavior).
   *
   * @param args   - The original tool call arguments
   * @param result - The original result content as plain text
   * @returns Replacement string, or null to keep as-is
   */
  compactResult?: (args: Record<string, unknown>, result: string) => string | null;
  /**
   * When false the tool may run concurrently with other concurrent-safe
   * tools in the same batch.  Defaults to true (serial / exclusive).
   *
   * Set `serial: false` only on read-only or side-effect-free tools
   * (read_file, grep, glob, web_search, …).
   */
  serial?: boolean;
  /**
   * API keys this tool needs from key/tools.json.
   * The framework auto-registers empty placeholders for any missing keys at capability load time.
   * Tools only need to declare; the framework handles registration.
   */
  requiredKeys?: Array<{ key: string; description: string }>;
}

// ─── DynamicRegistry — unified runtime register/release interface ───

/**
 * Generic interface for runtime (in-memory) registration of capabilities.
 * All three capability systems (slot / tool / plugin) implement this
 * with their respective instance type T so their dynamic APIs stay symmetric.
 */
export interface DynamicRegistry<T> {
  register(key: string, instance: T): void;
  release(key: string): void;
  get(key: string): T | undefined;
  list(): T[];
}

/** Slot-specific dynamic API: adds content-centric `update` helper. */
export interface DynamicSlotAPI extends DynamicRegistry<string> {
  update(id: string, content: string): void;
}

/** Runtime tool registration/release, exposed as ctx.tools in AgentContext. */
export type DynamicToolAPI = DynamicRegistry<ToolDefinition>;

import type { PluginSource } from "../capability/plugin/types.js";

/** Runtime plugin registration/release, exposed as ctx.plugins in AgentContext. */
export type DynamicPluginAPI = DynamicRegistry<PluginSource>;

import type { AgentLedgerAPI } from "../session/types.js";

// ─── TeamBoard (reactive state registry) ───

export type WatchCallback = (value: unknown, prev: unknown) => void;

export interface TeamBoardSetOptions {
  persist?: boolean;
}

export interface TeamBoardAPI {
  set(agentId: string, key: string, value: unknown, options?: TeamBoardSetOptions): void;
  get(agentId: string, key: string): unknown;
  remove(agentId: string, key: string): void;
  removeAll(agentId: string): void;
  removeByPrefix(prefix: string): void;
  getAll(agentId: string): Record<string, unknown>;
  agentIds(): string[];
  watch(agentId: string, key: string, cb: WatchCallback): () => void;
  loadFromDisk(): void;
  registerFSWatcher(watcher: FSWatcherAPI): void;
}

// ─── Shared capability context ───

export interface AgentContext {
  agentId: string;
  agentDir: string;
  signal: AbortSignal;
  eventBus: EventBusAPI;
  teamBoard: TeamBoardAPI;
  pathManager: PathManagerAPI;
  /** CWD-aware path resolution — resolves relative paths against CURRENT_DIR. */
  fs: import("../sandbox/fs-bridge.js").AgentFsAPI;
  /** Returns the live in-memory agent.json reference for this agent. */
  getAgentJson: () => AgentJson;
  /** Agent tree — query topology + mutate nodes. */
  tree: AgentTreeAPI;
  /** Hook type constants — use ctx.hook.TurnEnd etc. instead of importing Hook directly. */
  hook: import("../hooks/types.js").HookTable;
  /** Per-agent event ledger — tools may read events or roll a new shard. */
  ledger?: AgentLedgerAPI;
  /** The SessionRuntime this agent belongs to. Use this instead of the
   *  legacy global getInstanceScheduler() — that pattern assumes one
   *  scheduler per instance and breaks under multi-session. */
  session?: import("./session-runtime.js").SessionRuntimeAPI;
  slots: DynamicSlotAPI;
  tools: DynamicToolAPI;
  plugins: DynamicPluginAPI;
}


// ─── PathManager + FSWatcher (canonical definitions in fs/types.ts) ───

export type {
  CapabilityLayerAPI,
  SharedLayerAPI,
  InstanceLayerAPI,
  TeamLayerAPI,
  AgentLayerAPI,
  PathManagerAPI,
  WatchRegistration,
  FSChangeEvent,
  FSHandler,
  FSWatcherAPI,
} from "../fs/types.js";

// ─── Terminal Manager (canonical definitions in terminal/types.ts) ───

export type {
  TerminalInstance,
  ExecBaseOpts,
  ExecOpts,
  ExecSyncOpts,
  TerminalManagerAPI,
  ExecResult,
  WaitResult,
} from "../terminal/types.js";

// ─── Agent Interface ───

export interface AgentInterface {
  id: string;
  run(signal: AbortSignal): Promise<void>;
  stop?(): void;
  shutdown?(): Promise<void>;
  free?(): Promise<void>;
}

// ─── Agent Init Config (passed to BaseAgent constructor) ───

export interface AgentInitConfig {
  id: string;
  agentDir: string;
  agentJson: AgentJson;
  teamBoard: TeamBoardAPI;
  agentTree: AgentTreeAPI;
  eventBus: import("./event-bus.js").EventBus;
  fsWatcher?: FSWatcherAPI;
  /** Back-pointer to the SessionRuntime this agent belongs to. Optional
   *  for backward compatibility with callers that build AgentInitConfig
   *  directly; SessionRuntime / Scheduler always populate it from P2 on. */
  sessionRuntime?: import("./session-runtime.js").SessionRuntimeAPI;
}

// ─── Instance types (canonical definitions in instance/types.ts) ───

export type {
  InstanceStatus,
  ProvisioningPhase,
  TeamInfoPayload,
  InstanceHandle,
  InstanceConfig,
  CapabilityItem,
  CapabilityPackageSummary,
  CapabilityLayer,
  CapabilitiesIntrospection,
  CapabilityPackageDetail,
  SkillSummary,
  SkillLayer,
  SkillsIntrospection,
  TemplateSummary,
  TemplateLayer,
  TemplatesIntrospection,
  TemplateDetail,
  BackupInfo,
  StoredEvent,
} from "../instance/types.js";

export {
  PROVISIONING_PHASE_LABEL,
  INSTANCE_STATUS_PENDING,
  INSTANCE_STATUS_TERMINAL,
} from "../instance/types.js";
