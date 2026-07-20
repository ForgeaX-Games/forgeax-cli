/**
 * runForkedAgent —— cache-safe fork(缓存安全的后台提取原语)。
 *
 * 与隔离 subagent(`subagent.ts`,自带空 messages / 自己的 slots)**本质不同**:fork
 * **逐字节复用父这一轮的上下文**(system slots + tools + model + messages),**只在尾部
 * 追加一条 user 指令**。这样 provider 请求的前缀 = 父刚发那次的前缀 → 整段走 **cache-read**;
 * 新 token 只有「追加指令 + 提取自身输出」。这是 cc `runForkedAgent` 的对应物
 * (见 `.claude/openResource/claude-code-source-code` `services/extractMemories`)。
 *
 * 关键不变量(单测断言):
 *   1. fork 的 system/tools/messages **前缀 == 父快照**(同 slots/tools/model + initialMessages);
 *   2. 只**追加一条** user message(`instruction`);
 *   3. 工具门控**只拦执行、不改工具定义**(name/description/schema 原样)→ 缓存键不变。
 *
 * 用途:Step4/5 用它替掉 core/soul 两套缓存全冷的 `extract()`/`runAutoExtract()`。fork 用**真实
 * Write/Edit 工具**写盘(故能先 Read 已有去重),写权限经 `canUseTool` 锁在 memory 目录内。
 *
 * Boundary: 仅 core 相对 import。
 */
import { CoreAgent } from './agent';
import { EventBus } from '../events/event-bus';
import type { AgentContext, TerminalReason } from './types';
import type { LLMProvider, ProviderMessage } from '../provider/types';
import type { AgentTool, Slot, ToolContext, PermissionResult } from '../capability/types';

/** fork 的「LLM↔工具」往返硬上限(read→write,防失控)。对齐 cc extractMemories 的 maxTurns:5。 */
export const DEFAULT_FORK_MAX_TURNS = 5;

export interface ForkedAgentSpec {
  /** 父这一轮的完整 messages —— 要逐字节复用的缓存前缀。 */
  parentMessages: ProviderMessage[];
  /** 父的 system slots —— fork 装配出的 system 必须与父字节一致才命中缓存。 */
  systemPromptSlots?: Slot[];
  /** 父的 system 首段(与 AgentContext.config.leadingSystemText 同型:可为延迟函数)。 */
  leadingSystemText?: string | (() => string | null);
  /** 父的 model(缓存键一部分)。 */
  model: string;
  /** 父的工具集(**同一份** → 缓存键匹配);执行由 canUseTool 门控。 */
  tools: AgentTool[];
  /** 尾部追加的唯一一条 user 指令(提取提示词)。 */
  instruction: string;
  /** 执行门控:返回 true 放行该工具调用。拒绝 → 该工具得到一条 deny 结果
   *  (工具定义保持原样 → 缓存不破)。缺省 ⇒ 全放行。 */
  canUseTool?: (toolName: string, input: unknown) => boolean;
  /** 往返硬上限。默认 5。 */
  maxTurns?: number;
  contextWindow?: number;
}

export interface ForkedAgentDeps {
  provider: LLMProvider;
  toolContext?: Omit<ToolContext, 'signal'>;
  signal?: AbortSignal;
}

export interface ForkedAgentResult {
  /** fork 最终回答(诊断用;真正产物是写盘的文件)。 */
  text: string;
  terminalReason: TerminalReason;
  turns: number;
  /** fork 期间 Write/Edit 工具写过的 file_path(去重)。 */
  writtenPaths: string[];
  /** fork 期间工具调用总次数(soul 经 `remember` MCP 工具写时 writtenPaths 为空,用此计数)。 */
  toolCalls: number;
}

function lastAssistantText(message: { payload?: unknown }): string {
  const content = (message.payload as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** 从 Write/Edit 工具调用的 input 取 file_path(其它工具返回 null)。认 canonical + 别名。 */
const WRITE_TOOL_NAMES = new Set(['Write', 'write_file', 'Edit', 'edit_file']);
function writtenPathOf(toolName: string, input: unknown): string | null {
  if (!WRITE_TOOL_NAMES.has(toolName)) return null;
  if (input && typeof input === 'object' && 'file_path' in input) {
    const fp = (input as { file_path: unknown }).file_path;
    return typeof fp === 'string' ? fp : null;
  }
  return null;
}

/**
 * 包一层门控:`checkPermissions` 先问 canUseTool,拒则 deny;**name/description/schema/call 原样**
 * → 发给 provider 的工具定义字节不变,缓存键不破(对齐 cc:收权限靠 canUseTool 回调,不改工具列表)。
 */
function gateTool(tool: AgentTool, canUse: (name: string, input: unknown) => boolean): AgentTool {
  return {
    ...tool,
    // 对齐 cc canUseTool:放行的工具**直接 allow**(编排层已预授权 memory-dir 写),不再委托原
    // checkPermissions——否则原策略可能判 'ask',而 fork 无 askUser → fail-closed deny,写不进盘。
    async checkPermissions(input: unknown, _ctx: ToolContext): Promise<PermissionResult> {
      if (!canUse(tool.name, input)) {
        return {
          behavior: 'deny',
          message: `forked extraction: tool '${tool.name}' not permitted (memory-dir writes + read-only tools only)`,
        };
      }
      return { behavior: 'allow', updatedInput: input };
    },
  } as AgentTool;
}

/**
 * 跑一个 cache-safe fork:复用父上下文 + 追加一条指令,跑到 done,返回写盘的文件路径。
 * fork 用**独立 EventBus**(不污染父 transcript / 不向父 bus publish);不写 EventStore
 * (默认 in-memory store,§6.5 stateless)。
 */
export async function runForkedAgent(
  spec: ForkedAgentSpec,
  deps: ForkedAgentDeps,
): Promise<ForkedAgentResult> {
  const tools = spec.canUseTool
    ? spec.tools.map((t) => gateTool(t, spec.canUseTool!))
    : spec.tools;

  const context: AgentContext = {
    agentId: 'memory-extract-fork',
    provider: deps.provider,
    config: {
      systemPromptSlots: spec.systemPromptSlots ?? [],
      leadingSystemText: spec.leadingSystemText,
      model: spec.model,
      tools,
      maxTurns: spec.maxTurns ?? DEFAULT_FORK_MAX_TURNS,
    },
    toolContext: deps.toolContext ?? {},
  };

  const child = new CoreAgent({
    context,
    bus: new EventBus(), // 隔离 bus:提取过程不流进父对话
    initialMessages: spec.parentMessages, // ★ 复用父前缀(缓存命中的根)
    contextWindow: spec.contextWindow,
    // E-04:提取 fork 是 core 自身的记忆簿记(bus 隔离 + canUseTool 门控 + 只写 memory 目录),
    //   非用户/模型自由编辑;显式关闭 secure-by-default safetyCheck,否则写 `.forgeax/memory/*.md`
    //   会被受保护路径检查拦下。
    enableSafetyCheck: false,
  });

  let text = '';
  let terminalReason: TerminalReason = 'completed';
  let turns = 0;
  let toolCalls = 0;
  const seen = new Set<string>();
  const writtenPaths: string[] = [];

  for await (const ev of child.run({
    input: { type: 'user', payload: spec.instruction, ts: 0 },
    signal: deps.signal,
  })) {
    if (ev.type === 'assistant') {
      const t = lastAssistantText(ev.message);
      if (t) text = t;
    } else if (ev.type === 'tool_call') {
      toolCalls++;
      const fp = writtenPathOf(ev.toolName, ev.input);
      if (fp && !seen.has(fp)) {
        seen.add(fp);
        writtenPaths.push(fp);
      }
    } else if (ev.type === 'turn_start') {
      turns = ev.turn + 1;
    } else if (ev.type === 'done') {
      terminalReason = ev.terminal.reason;
    }
  }

  return { text, terminalReason, turns, writtenPaths, toolCalls };
}
