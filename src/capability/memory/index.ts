/**
 * Memory capability pack (C8) — generic long-term memory mechanism.
 *
 * core 只出**通用机制**:scan(frontmatter manifest)+ recall(LLM-select over
 * manifest,无 embedding)+ tools(memory_search / remember,写闸限 memory 目录)+
 * slot(常驻 MEMORY.md 索引)。**不含任何专有分类语义**——taxonomy 由调用方经
 * `remember.type` 字符串与 selectFn 自行定义。
 *
 * memdir 机制。host 注入 memoryDir(落盘位置)、sandboxFs(IO)、
 * 可选 selectFn(召回选择器,背靠小模型 side-query)。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { CapabilityPack, Plugin, PluginContext } from '../types';
import type { SandboxFs } from '../../inject/types';
import type { MemorySelectFn } from './recall';
import { CoreEventType } from '../../events/events';
import { makeMemorySearchTool, makeRememberTool } from './tools';
import { makeMemorySlot, type ResidentMemorySlot } from './slot';
import { makeMemoryBehaviorSlot } from './behavior-slot';

export type { MemoryHeader } from './scan';
export { scanMemoryFiles, formatManifest, MAX_MEMORY_FILES, FRONTMATTER_MAX_LINES, MEMORY_INDEX_FILE } from './scan';
export type { MemorySelectFn, RelevantMemory } from './recall';
export { findRelevantMemories } from './recall';
export { makeMemorySearchTool, makeRememberTool, isAutoMemPath, freshness, memoryFreshnessText, type MemoryToolDeps } from './tools';
export { makeMemorySlot, rebuildIndex, type MemorySlotDeps, type ResidentMemorySlot } from './slot';
export { makeMemoryBehaviorSlot, type MemoryBehaviorSlotDeps } from './behavior-slot';
export { AutoMemory, makeProviderSelectFn, type AutoMemoryDeps, type ForkRunner } from './auto';
export { buildExtractInstruction, buildConsolidateInstruction, makeMemoryDirCanUseTool } from './extract-prompt';
export { listMemory, openMemory, type MemoryEntry, type MemoryListing } from './inspect';

export interface MemoryPackDeps {
  /** 记忆落盘根目录(host 经 PathConvention 决定布局)。 */
  memoryDir: string;
  /** 抽象 IO(host 注入)。 */
  sandboxFs: SandboxFs;
  /** 召回选择器(可选;无则回退取最新 N)。 */
  selectFn?: MemorySelectFn;
}

/**
 * 常驻索引记忆化的失效 plugin:订阅 bus,在**缓存前缀本就作废**的两个边界丢弃 slot
 * 的记忆化结果(下一轮 render 重读磁盘,零额外缓存成本):
 *   - `/clear` —— SessionEnd 且 reason='clear'(TUI 对旧会话补发;agent 每 run 收尾
 *     也发 SessionEnd,但 reason 是终态如 'completed',**不失效**——TUI 下每条用户消息
 *     就是一个 run,按 run 失效等于退回每轮重读的 bug)。
 *   - compaction —— CompactionApplied(历史已重写,顺带把索引刷新到最新盘上状态)。
 * ctx 无 bus(host 不接事件)→ 不订阅:记忆化仍成立,只是索引到进程结束才刷新。
 */
function makeIndexInvalidator(slot: ResidentMemorySlot): Plugin {
  return {
    name: 'memory-index-invalidator',
    start(ctx: PluginContext) {
      const bus = ctx.bus;
      if (!bus) return () => {};
      const unsubs = [
        bus.subscribe(CoreEventType.SessionEnd, (ev) => {
          if ((ev.payload as { reason?: string } | undefined)?.reason === 'clear') slot.invalidate();
        }),
        bus.subscribe(CoreEventType.CompactionApplied, () => {
          slot.invalidate();
        }),
      ];
      return () => {
        for (const u of unsubs) u();
      };
    },
  };
}

/** 组装 memory capability pack(builtin 层)。 */
export function memoryPack(deps: MemoryPackDeps): CapabilityPack {
  const toolDeps = { memoryDir: deps.memoryDir, sandboxFs: deps.sandboxFs, selectFn: deps.selectFn };
  const memorySlot = makeMemorySlot({ memoryDir: deps.memoryDir, sandboxFs: deps.sandboxFs });
  return {
    name: 'memory',
    layer: 'builtin',
    tools: [makeMemorySearchTool(toolDeps), makeRememberTool(toolDeps)],
    slots: [
      // 行为提示(怎么/何时写记忆 + 召回信任)在前,MEMORY.md 索引内容在后。两者皆 static,进稳定缓存前缀。
      makeMemoryBehaviorSlot({ memoryDir: deps.memoryDir }),
      memorySlot,
    ],
    plugins: [makeIndexInvalidator(memorySlot)],
  };
}
