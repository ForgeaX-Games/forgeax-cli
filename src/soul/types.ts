/**
 * 数字生命引擎（R6）类型 —— soul-pack → 可跑 agent 的中立产物。
 *
 * 这层属**编排层**(我们这块),不是内核。引擎把一个 AI 的「生命」(人格+技能
 * +分层记忆)从 soul-pack 解析成 `AgentRecord`,由 R2 `composeTurnRequest`
 * 注入 `TurnRequest`。`TrustTier` 复用内核契约里的 pass-through 定义(权威 =
 * 加载路径,非 pack 自报)。
 *
 * 设计依据:`forgeax-soul-pack-与-lean-v1-规格.md` + `需求单/R6-数字生命引擎-需求单.md`。
 */
import type { ToolSpec, TrustTier } from '@forgeax/agent-runtime';

export type { TrustTier };

/** soul 的来源(决定 trustTier)。builtin/forge → own;marketplace/user-imported → imported。 */
export type SoulSource = 'builtin' | 'forge' | 'marketplace' | 'user-imported';

/** 记忆分层(规格 §2):identity=T0 魂(不可变内核)· traits=T1 可移植倾向 ·
 *  episodes=T2 情景(按 game 归档)。 */
export type MemoryTier = 'identity' | 'traits' | 'episodes';

/** 分层记忆引用 —— 指向可写运行时记忆根 + 当前游戏世界。
 *  约定根 = `<projectRoot>/.forgeax/souls/<agentId>/memory`。 */
export interface LayeredMemoryRef {
  /** 记忆根目录(绝对路径)。 */
  root: string;
  /** 当前游戏世界 slug;转世/携带按此隔离 episodes。无 = 通用上下文。 */
  game?: string;
}

/** 技能引用(轻量)——不耦合 SkillRunner,只够编排层经 MCP 下发 + agent 自知。 */
export interface SkillRefLite {
  skillId: string;
  pluginId: string;
  kind: string;
  description: string;
}

/** 一条记忆(磁盘上一个 *.md 文件)。 */
export interface MemorySection {
  /** 相对记忆根的路径,如 `traits/fav-color.md`。 */
  file: string;
  body: string;
  tier: MemoryTier;
  /** 仅 episodes 有:所属游戏世界。 */
  game?: string;
}

/** 引擎产出:soul-pack「重生」成的可跑 agent 记录。喂给 R2 composeTurnRequest。 */
export interface AgentRecord {
  agentId: string;
  source: SoulSource;
  /** 权威 = 加载路径(非 pack 自报)。 */
  trustTier: TrustTier;
  /** T0 身份/人格 → systemPrompt.persona。 */
  persona: string;
  skills: SkillRefLite[];
  /** → TurnRequest.tools(经 MCP 下发)。 */
  tools: ToolSpec[];
  /** pack 声明的系统提示词应用方式(manifest.json::systemPrompt.mode)。
   *  → ComposedPrompt.mode。缺省/无 manifest ⇒ undefined(内核当 append)。 */
  promptMode?: 'append' | 'replace';
  /** pack 声明的工具面策略(manifest.json::tools.allow/deny)。→ TurnRequest.toolPolicy。
   *  opaque 内核原生工具名,缺省 ⇒ undefined(内核默认=全部工具)。 */
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** pack 声明的预算硬闸(manifest.json::budget)。→ TurnRequest.budget(--max-turns/--max-budget-usd)。
   *  缺省 ⇒ undefined(编排层填 {} = 无上限)。 */
  budget?: { maxTurns?: number; maxBudgetUsd?: number };
  /** identity / traits / episodes 分层记忆引用。 */
  memory: LayeredMemoryRef;
  /** 解析过程的非致命告警(缺可选字段等)。 */
  warnings: string[];
}

/** 一条待写入的记忆事实(写时分类的输入)。 */
export interface MemoryFact {
  text: string;
  /** 'general' → traits(可移植);'game' → episodes/<game>;省略/低置信 → episodes(不污染可移植层)。 */
  kind?: 'general' | 'game';
  /** 可选标题,用于生成文件名 + 索引摘要。 */
  title?: string;
}

/** 重生事件流(编排层内部可观测,非内核契约)。 */
export type LifeEvent =
  | { kind: 'soul.loaded'; agentId: string; source: SoulSource; trustTier: TrustTier; at: number }
  | { kind: 'rebirth.projected'; agentId: string; into: string; at: number }
  | { kind: 'memory.written'; agentId: string; tier: MemoryTier; game?: string; file: string; at: number };
