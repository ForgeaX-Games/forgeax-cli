/** Core public types for the runtime layer.
 *
 *  Two halves:
 *    1. LLM-facing slice (ContentPart / ModelSpec / ModelsConfig / ToolDefinition).
 *       Pre-existing — used by the provider layer in src/llm/.
 *    2. Runtime-facing slice (Event / EventBusAPI / SchedulerAPI / AgentNode /
 *       AgentJson / SessionConfig / BlackboardAPI / TreeChange / ...).
 *       Added in C0 — public contracts for core/, session/, message/, hooks/.
 *
 *  This file holds only public interfaces. Implementations live in their
 *  respective modules (event-bus.ts / scheduler.ts / blackboard.ts / etc.). */

// ─── Content (9-variant) ───

export type ContentPart =
  | { type: "text"; text: string }
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
export type FileMediaContentPart = Extract<ContentPart, { type: "image_file" | "video_file" | "audio_file" }>;
export type MediaContentPart = InlineMediaContentPart | FileMediaContentPart;

/** Event payload carrying a content slice —— message-ingress 把它升格成 user LLMMessage。 */
export interface ContentPayload {
  content: EventContent;
  [key: string]: unknown;
}

export function isContentPayload(payload: unknown): payload is ContentPayload {
  if (!payload || typeof payload !== "object") return false;
  return "content" in payload;
}

export function isMediaContentPart(part: ContentPart): part is MediaContentPart {
  return part.type === "image" || part.type === "video" || part.type === "audio"
    || part.type === "image_file" || part.type === "video_file" || part.type === "audio_file";
}

export function isInlineMediaContentPart(part: ContentPart): part is InlineMediaContentPart {
  return part.type === "image" || part.type === "video" || part.type === "audio";
}

export function isFileMediaContentPart(part: ContentPart): part is FileMediaContentPart {
  return part.type === "image_file" || part.type === "video_file" || part.type === "audio_file";
}

// ─── Model spec ───

export type InputModality = "text" | "image" | "video" | "audio";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSpec {
  input: InputModality[];
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  defaultTemperature: number;
}

// ─── Models config (per-agent / per-session) ───

export interface ModelsConfig {
  /** Model name — single string or fallback chain. null means "inherit from parent". */
  model?: string | string[] | null;
  routing?: {
    stickiness?: {
      enabled?: boolean;
      ttlMs?: number;
      cooldownMs?: number;
    };
  };
  temperature?: number | null;
  maxTokens?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  showThinking?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeout?: number;
}

// ─── Agent config (agent.json schema) ───
//
// 字段范围限定在本轮 runtime rewrite (C0-C12) 真正用到的部分；
// `kits` 字段引用 kits 子系统的 KitsConfig（loader/registry 骨架
// 在 src/kits/，内容填充见 runtime-rewrite-gaps.md §B1）。

export interface AgentJson {
  /** LLM 模型配置；缺则继承 SessionConfig.defaultModels。 */
  models?: ModelsConfig;
  /** EventBus 合并窗口（ms），同源同类型事件在窗口内合并。 */
  coalesceMs?: number;
  /** 单 turn 内最大 LLM 调用次数（防失控）。 */
  maxIterations?: number;
  /** 历史保留 / micro-compaction 触发参数 —— 由 context-window/micro-compaction 消费。
   *  当 `Date.now() - LAST_USER_INPUT_AT >= idleGapMs` 时压缩保护区外的历史；
   *  保护区 = 最近 N 个 tool_result + 最近 N 个含媒体消息。 */
  historyKeep?: {
    /** 保护区内保留的 tool_result 条数。 */
    recentTools?: number;
    /** 保护区内保留的含媒体（图/音/视）消息条数。 */
    recentMedias?: number;
    /** Idle-gap 阈值（ms）。 */
    idleGapMs?: number;
  };
  /** 时区，用于 prompt 内 CURRENT_TIME 渲染。 */
  timezone?: string;
  /** Agent CWD（相对 agent home 或绝对路径）；blackboard CURRENT_DIR 初值。 */
  defaultDir?: string;
  /** Blackboard STATUS 键的初值；缺则空串。 */
  defaultStatus?: string;
  /** kits 可见性 + per-kit 运行时 config。
   *  Loader/Registry 骨架在 src/kits/；填充进度见 runtime-rewrite-gaps.md §B1。 */
  kits?: import("../kits/types").KitsConfig;
  /** kit 目录重定向 —— 相对 agent root 或绝对路径，用于把 kits/ 软链到外部
   *  目录（如游戏 project 内）。缺省走 `<agent-root>/kits/`。 */
  kitRedirect?: string;
  /** Persona markdown 路径（绝对或相对 projectRoot）。Sub-agent 由
   *  marketplace plugin / 旧 manifest 衍生时由 sessions API 自动写入。
   *  builtin/kits/persona/slots/persona.ts 读取此字段把 persona 注入
   *  ContextEngine 作为 STATIC_CORE 优先级的 stable SystemBlock。 */
  personaFile?: string;
  /** Long-term memory 目录（绝对或相对 projectRoot / marketplace 根）。
   *  Sub-agent 由 plugin / marketplace manifest 衍生时由 sessions API
   *  自动写入。builtin/kits/persona/slots/memory.ts 读取此字段，把目录里
   *  全部 .md 文件拼成 SystemBlock 注入 prompt。值为空 / 读不到 → slot
   *  静默 skip，不影响 persona slot。 */
  memoryDir?: string;
}

// ─── Session config (session.json schema) ───

export interface SessionConfig {
  /** UI display name; may be empty. */
  displayName?: string;
  /** game-project slug locked to this session. Resolved at agent boot by
   *  `_buildSession` via `pm.user().gameDir(defaultDir)` and accessible as
   *  `agentContext.cwd`. Required at create() time. */
  defaultDir: string;
  /** Inherited by agent.json::models when an agent leaves the field unset. */
  defaultModels?: ModelsConfig;
  timezone?: string;
  /** Server-boot autoStart flag. Default true; explicit false to skip. */
  autoStart?: boolean;
}

// ─── Event system ───

export type EventHandoff = "silent" | "passive" | "turn" | "innerLoop" | "steer";

export interface EventPayload {
  /** Display / log content. NOT directly fed to LLM. */
  content?: EventContent;
  /** Human-readable display text for files & UI. */
  visual_display?: string;
  /** Materialized LLM message(s) attached by the agent layer. */
  llmMessage?: import("../llm/types").LLMMessage | import("../llm/types").LLMMessage[];
  /** Renderer flags. */
  error?: string;
  warning?: string;
  [key: string]: unknown;
}

export interface EventBase {
  source: string;
  type: string;
  payload: EventPayload;
  ts: number;
  /** 0 = immediate, 1 = normal (default), 2 = low. */
  priority?: number;
  /** Attached by EventBus.publish before observers run. */
  block?: (reason?: string) => void;
  isBlocked?: () => boolean;
  blockReason?: string;
}

/** Routed events carry `to` + optional `handoff`; observe-only events have neither. */
export type Event = EventBase & (
  | { to: string; handoff?: EventHandoff }
  | { to?: undefined; handoff?: undefined }
);

/** Self-routed event — `to` is auto-filled to the emitting agent's id. */
export type SelfEvent = EventBase & { handoff?: EventHandoff };

export interface EventQueueAPI {
  push(event: Event): void;
  drain(filter?: (event: Event) => boolean): Event[];
  pending(): number;
  hasHandoff(handoff: EventHandoff): boolean;
  onSteer(cb: () => void): { dispose(): void };
}

export interface EventBusAPI {
  publish(event: Event, emitterId?: string): void;
  emit(event: Event, emitterId?: string): void;
  emitToSelf(event: SelfEvent): void;
  /** Publish a hook event — observers only, source + ts auto-filled. */
  hook(type: string, payload: EventPayload): Event;
  observe(handler: (event: Event, emitterId?: string) => void): () => void;
  /** Observe only events from a specific agent (filtered by emitterId). */
  observeAgent(agentId: string, handler: (event: Event) => void): () => void;
}

// ─── Agent tree ───

export interface AgentNode {
  /** "/"-separated path from session root, e.g. "root/iori/suzu". */
  path: string;
  /** Last segment of path, e.g. "suzu". */
  display: string;
  /** Number of segments in path; root agent depth=1. */
  depth: number;
  /** "<display>#<depth>" — globally unique within the tree. */
  fullId: string;
  /** Parent path; undefined for the root agent. */
  parent?: string;
}

export interface TreeChange {
  kind: "added" | "removed";
  node: AgentNode;
}

export interface AgentTreeAPI {
  /** Owning session id (SSOT — same value as Session.sid). Tools that need
   *  to scaffold new agent dirs (delegate_to_subagent) read sid from here
   *  rather than threading session refs through AgentContext. */
  readonly sid: string;
  /** Lookup by full path (SSOT). */
  get(path: string): AgentNode | undefined;
  /** Lookup by "<display>#<depth>" — globally unique. */
  getByFullId(fullId: string): AgentNode | undefined;
  /** Friendly lookup. Throws when display is ambiguous; caller should fall back to fullId. */
  findByDisplay(display: string): AgentNode;
  parent(path: string): AgentNode | undefined;
  children(path: string): AgentNode[];
  list(): AgentNode[];
  /** Tree-derived writable paths (self + direct children + shared workspace). */
  getWritablePaths(path: string): string[];
  /** Subscribe to add/remove events fired by the underlying fs-watcher.
   *  Returns unsubscribe. */
  onChange(handler: (changes: TreeChange[]) => void): () => void;
}

// ─── Blackboard (per-session reactive KV) ───

export type BlackboardWatch = (value: unknown, prev: unknown) => void;

export interface BlackboardSetOptions {
  /** Default true — persisted to <sid>/blackboard.json. */
  persist?: boolean;
}

export interface BlackboardAPI {
  set(agentId: string, key: string, value: unknown, opts?: BlackboardSetOptions): void;
  get(agentId: string, key: string): unknown;
  remove(agentId: string, key: string): void;
  removeAll(agentId: string): void;
  removeByPrefix(prefix: string): void;
  getAll(agentId: string): Record<string, unknown>;
  agentIds(): string[];
  watch(agentId: string, key: string, cb: BlackboardWatch): () => void;
  /** Hydrate from disk. Called once during Session construction. */
  loadFromDisk(): void;
  /** Force write of the persisted subset. SessionManager.close calls this. */
  flush(): void;
}

// ─── Scheduler ───

export interface SchedulerAPI {
  /** Register an agent path. Idempotent. */
  attachAgent(agentPath: string): Promise<void>;
  /** Begin scheduling for a single agent (claims its lifecycle lock). */
  startAgent(agentPath: string): Promise<void>;
  /** Push an external message into an agent's inbox. */
  routeMessage(agentPath: string, event: Event): void;
  /** Begin processing for the whole session — observe bus + drive turn loops. */
  start(): void;
  /** Soft stop — drain in-flight turns, leave bus / tree / ledger intact. */
  shutdown(): Promise<void>;
}

// ─── Tools (LLM-facing slice; full ToolDefinition lives elsewhere) ───

export type ToolOutput = string | ContentPart[];

/** AgentContext —— BaseAgent 暴露给 kit / tool / slot / plugin 的统一入口。
 *
 *  对齐 agenteam ref `core/base-agent.ts` L148-163：agentContext 是
 *  **per-agent 共享对象**（同一 agent 内的所有 kit 看见同一个引用），构造
 *  时由 BaseAgent 注入 3 个 registry 实例 + 现有 EventBus/Blackboard/Tree。
 *
 *  循环依赖：core 反向引用 `kits/slot/types.ts` 的 `ContextSlot` 与
 *  `kits/types.ts` 的 `PluginSource` —— **type-only**，tsc 允许，runtime 不绑。 */
export interface AgentContext {
  agentPath: string;
  agentDir: string;
  signal: AbortSignal;
  eventBus: EventBusAPI;
  blackboard: BlackboardAPI;
  tree: AgentTreeAPI;
  hook: typeof import("../hooks/types").Hook;
  getAgentJson(): AgentJson;
  /** Tool registry —— ConsciousAgent buildPrompt / executeTool 直接消费。 */
  tools: ToolRegistryAPI;
  /** Slot registry —— context-engine 拼 prompt 时遍历。 */
  slots: SlotRegistryAPI;
  /** Plugin registry —— hook dispatch + dynamic register/release。 */
  plugins: PluginRegistryAPI;
	/** Absolute cwd resolved from session.config.defaultDir at agent boot. */
	readonly cwd: string;
  /** CWD-aware filesystem facade for workspace tools.
   *  当前为「宿主机直读」实现（packages/server/src/fs/agent-fs.ts）。
   *  Sandbox 介入后会按 defaultDir 指向的 game-project 路径自动路由进容器，
   *  调用方语义无变化 —— 见 architecture 03-sandbox.md（TODO）。 */
  fs: import("../fs/agent-fs").AgentFsAPI;
  /** 进程单例 PathManager —— 给工具解析 builtin / user / session / agent 路径。 */
  pathManager: import("../fs/types").PathManagerAPI;
  /** 终端管理器（持久 bash session + 后台 / 等待 / 日志）。
   *  当前为宿主机实现（packages/server/src/terminal/manager.ts）。
   *  后续 sandbox 启用后会与 defaultDir 指向的 game-project 容器联动，
   *  接口对调用方保持不变。 */
  terminal: import("../terminal/types").TerminalManagerAPI;
  /** Per-agent ledger reader for context-window compaction. Set by ConsciousAgent. */
  ledger?: import("../context-window/context-window").LedgerReader;
  /** Resolved models config getter for compaction. Set by ConsciousAgent. */
  resolveModels?: () => ModelsConfig;
}

/** ToolRegistry 公开面 —— BaseAgent 给的是 ToolRegistry 类，kit / context-engine
 *  / ConsciousAgent 都按这个接口消费。dynamic 区由 register/release 维护。 */
export interface ToolRegistryAPI {
  list(): ToolDefinition[];
  get(key: string): ToolDefinition | undefined;
  register(key: string, tool: ToolDefinition): void;
  release(key: string): void;
}

/** SlotRegistry 公开面。`ContextSlot` 实体留在 `kits/slot/types.ts`。 */
export interface SlotRegistryAPI {
  list(): import("../kits/slot/types").ContextSlot[];
  get(key: string): import("../kits/slot/types").ContextSlot | undefined;
}

/** PluginRegistry 公开面。`PluginSource` 实体留在 `kits/types.ts`。 */
export interface PluginRegistryAPI {
  list(): import("../kits/types").PluginSource[];
  get(key: string): import("../kits/types").PluginSource | undefined;
  register(key: string, plugin: import("../kits/types").PluginSource): void;
  release(key: string): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Optional gate — if provided and returns false, tool is hidden from this turn's LLM call. */
  condition?: (ctx: AgentContext, self?: ToolDefinition) => boolean;
  modelFilter?: (model: string) => boolean;
  guidance?: string;
  ccVersion?: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  validateInput?: (
    args: Record<string, unknown>,
    ctx: AgentContext,
  ) => string | undefined | Promise<string | undefined>;
  execute: (
    args: Record<string, unknown>,
    ctx: AgentContext,
  ) => Promise<ToolOutput>;
  formatDisplay?: (args: Record<string, unknown>, result: ToolOutput) => string;
  maxResultChars?: number;
  compactResult?: (args: Record<string, unknown>, result: string) => string | null;
  serial?: boolean;
  requiredKeys?: Array<{ key: string; description: string }>;
}
