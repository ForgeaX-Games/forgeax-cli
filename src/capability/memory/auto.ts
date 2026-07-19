/**
 * Auto-memory engines(两个 "auto" 行为):
 *   1. **auto recall** —— 每个 user turn 自动召回相关记忆 → 作 system-reminder 注入(LLM-select)。
 *   2. **auto extract** —— 回合结束后台抽取,经注入的 **cache-safe fork**(`forkRunner`)用真实
 *      Write/Edit 工具内联写盘(对齐 cc:复用父缓存前缀,模型先 Read 已有再写、去重)。
 *
 * 干净律 + 边界:capability 层**不 import agent 层**。fork 由 HOST 层(cli/tui)用自身 context
 * 构造 `forkRunner` 注入进来(host 可 import runForkedAgent);recall 的 select 仍用注入 provider。
 * 无 forkRunner ⇒ extract 跳过(冷链路已删,§3「删除」)。Boundary: 仅 core 相对 import。
 */
import type { LLMProvider, ProviderRequest, ProviderMessage } from '../../provider/types';
import type { SandboxFs } from '../../inject/types';
import { scanMemoryFiles, formatManifest, type MemoryHeader } from './scan';
import { findRelevantMemories, type MemorySelectFn } from './recall';
import { MEMORY_BUDGET } from '../memory-seam';
import { freshness, memoryFreshnessText } from './tools';
import { rebuildIndex } from './slot';
import { buildExtractInstruction, buildConsolidateInstruction, makeMemoryDirCanUseTool } from './extract-prompt';
import { wrapSystemReminder } from '../../context/dynamic-reminder';

const NEVER_ABORT = new AbortController().signal;

/** 收集一次 provider 调用的 assistant 文本(供 recall 的 select sideQuery)。 */
async function collectText(provider: LLMProvider, req: ProviderRequest, signal: AbortSignal): Promise<string> {
  let text = '';
  for await (const ev of provider.stream(req, { signal })) {
    if (ev.type === 'assistant') {
      const content = (ev.message as { content?: Array<{ type: string; text?: string }> })?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      }
    }
  }
  return text;
}

function tryParseJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start)) as T;
  } catch {
    return null;
  }
}

const SELECT_SYS =
  'You select which stored memories are relevant to the user query. Return ONLY JSON ' +
  '{"selected":["filename.md", ...]} with at most 5 filenames you are CERTAIN are useful. Be selective; an empty list is fine.';

/** provider-backed selectFn(经 sideQuery 选相关记忆)。 */
export function makeProviderSelectFn(provider: LLMProvider, model: string): MemorySelectFn {
  return async (manifest: string, query: string): Promise<string[]> => {
    const req: ProviderRequest = {
      model,
      system: [{ type: 'text', text: SELECT_SYS }],
      tools: [],
      messages: [{ role: 'user', content: `Memory manifest:\n${manifest}\n\nUser query: ${query}` }],
      maxOutputTokens: 256,
    };
    const out = await collectText(provider, req, NEVER_ABORT);
    const parsed = tryParseJson<{ selected?: string[] }>(out);
    return Array.isArray(parsed?.selected) ? parsed!.selected!.filter((s) => typeof s === 'string') : [];
  };
}

/**
 * cache-safe fork 跑手(HOST 注入)。给定父 messages + 追加指令 + 写闸,跑一个复用父缓存前缀的
 * fork,返回写过的 file_path。HOST 用 runForkedAgent(agent 层)实现并绑定父 slots/tools/model/provider。
 */
export type ForkRunner = (
  parentMessages: ProviderMessage[],
  instruction: string,
  canUseTool: (toolName: string, input: unknown) => boolean,
  signal?: AbortSignal,
) => Promise<string[]>;

export interface AutoMemoryDeps {
  memoryDir: string;
  sandboxFs: SandboxFs;
  /** recall 的 select sideQuery 用;缺则 recall 退化取最新 N。 */
  provider?: LLMProvider;
  model?: string;
  /** ★ 召回选择器的**降级模型**(决策 5):便宜小模型专跑 select side-query。
   *  未传 → 用 `model`(主模型)。 */
  selectModel?: string;
  /** 覆盖默认 selectFn(否则由 provider 构造)。 */
  selectFn?: MemorySelectFn;
  /** ★ cache-safe fork 跑手(HOST 注入)。缺省 ⇒ extract 跳过(无冷兜底)。 */
  forkRunner?: ForkRunner;
  /** 每 N 个 user turn 抽取一次(节流)。默认 1。 */
  extractEveryNTurns?: number;
  /** ★ consolidation 阈值(决策 9,cc /dream 等价):memory 文件数 **≥ 此值**时,extract 后追跑
   *  一次「合并去重 + 清陈旧 + 整索引」蒸馏 fork(缓存安全、同写闸)。0 / 缺省 ⇒ 关(不蒸馏)。 */
  consolidateThreshold?: number;
  now?: () => number;
}

/**
 * 自动记忆引擎。host 构造并传给 CoreAgent;loop 每 user turn 调 recall、done 后调 extract。
 * 结构上满足 CoreAgent 的 AutoMemoryHook 接口。
 */
export class AutoMemory {
  private readonly d: AutoMemoryDeps;
  private readonly selectFn?: MemorySelectFn;
  private readonly now: () => number;
  private readonly extractEvery: number;
  private readonly surfaced = new Set<string>();
  private sessionBytes = 0;
  private extracting = false;
  private turnsSinceExtract = 0;
  /** 游标:上次抽取时的消息条数;新增 = messages.length - lastExtractCount(用于 instruction 的「recent ~N」)。 */
  private lastExtractCount = 0;

  constructor(deps: AutoMemoryDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.extractEvery = deps.extractEveryNTurns ?? 1;
    // select 用降级模型(selectModel)优先,缺则用主 model(决策 5)。
    const selModel = deps.selectModel ?? deps.model;
    this.selectFn = deps.selectFn ?? (deps.provider && selModel ? makeProviderSelectFn(deps.provider, selModel) : undefined);
  }

  /** 每个 user turn 调一次:返回要注入的 system-reminder 文本(相关记忆),或 null。 */
  async recall(query: string, _signal?: AbortSignal): Promise<string | null> {
    // gate(对齐 cc):空 / 单词 prompt 信息量不足以做有意义的相关性筛选 → 不召回。
    const q = (query ?? '').trim();
    if (!q || !/\s/.test(q)) return null;

    let headers: MemoryHeader[];
    try {
      headers = scanMemoryFiles(this.d.sandboxFs, this.d.memoryDir);
    } catch {
      return null; // 目录不存在等 → 无记忆
    }
    const fresh = headers.filter((h) => !this.surfaced.has(h.filename));
    if (fresh.length === 0) return null;

    const hits = await findRelevantMemories(fresh, query, this.selectFn);
    if (hits.length === 0) return null;

    const blocks: string[] = [];
    for (const h of hits) {
      if (this.sessionBytes >= MEMORY_BUDGET.sessionMaxBytes) break;
      let content: string;
      try {
        content = this.d.sandboxFs.readTextSync(h.filePath);
      } catch {
        continue;
      }
      // per-file 预算
      const lines = content.split('\n');
      if (lines.length > MEMORY_BUDGET.perFileMaxLines) content = lines.slice(0, MEMORY_BUDGET.perFileMaxLines).join('\n');
      if (content.length > MEMORY_BUDGET.perFileMaxBytes) content = content.slice(0, MEMORY_BUDGET.perFileMaxBytes);

      const head = `Memory (${freshness(h.mtimeMs, this.now())}): ${h.filename}`;
      const caveat = memoryFreshnessText(h.mtimeMs, this.now());
      blocks.push(caveat ? `${head}\n${caveat}\n\n${content}` : `${head}\n\n${content}`);
      this.surfaced.add(h.filename);
      this.sessionBytes += content.length;
    }
    if (blocks.length === 0) return null;
    return wrapSystemReminder(blocks.join('\n\n---\n\n'));
  }

  /**
   * done 后调一次(fire-and-forget):节流 + 互斥地经 **cache-safe fork** 后台抽取并内联写盘。
   * 无 forkRunner ⇒ 跳过(冷链路已删)。fork 复用父缓存前缀,模型用真实 Write/Edit 写 memory 目录。
   */
  async extract(messages: Array<{ role: string; content: unknown }>, signal?: AbortSignal): Promise<void> {
    this.turnsSinceExtract++;
    if (this.turnsSinceExtract < this.extractEvery) return;
    if (this.extracting || !this.d.forkRunner) return;
    this.extracting = true;
    try {
      let manifest = '';
      try {
        manifest = formatManifest(scanMemoryFiles(this.d.sandboxFs, this.d.memoryDir));
      } catch {
        /* 目录可能尚不存在 */
      }
      const recentCount = Math.max(1, messages.length - this.lastExtractCount);
      const instruction = buildExtractInstruction(this.d.memoryDir, manifest, recentCount);
      const gate = makeMemoryDirCanUseTool(this.d.memoryDir);
      const written = await this.d.forkRunner(messages as ProviderMessage[], instruction, gate, signal);
      // 成功:推进游标;写过文件则重建索引保证与盘一致(幂等)。
      this.lastExtractCount = messages.length;
      if (written.length > 0) {
        try {
          rebuildIndex(this.d.sandboxFs, this.d.memoryDir);
        } catch {
          /* 索引重建失败不影响已写记忆 */
        }
      }
      // consolidation(决策 9,cc /dream):文件数到阈值 → 追跑一次蒸馏 fork(缓存安全、同写闸、自调节)。
      await this.maybeConsolidate(messages as ProviderMessage[], gate, signal);
    } catch {
      /* 抽取失败不影响主流程(后台、best-effort) */
    } finally {
      this.extracting = false;
      this.turnsSinceExtract = 0;
    }
  }

  /** memory 文件数 ≥ consolidateThreshold 时,跑一次蒸馏 fork(合并去重 + 整索引)。阈值 0/缺省 ⇒ no-op。 */
  private async maybeConsolidate(
    parentMessages: ProviderMessage[],
    gate: (toolName: string, input: unknown) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const threshold = this.d.consolidateThreshold ?? 0;
    if (threshold <= 0 || !this.d.forkRunner) return;
    let headers: MemoryHeader[];
    try {
      headers = scanMemoryFiles(this.d.sandboxFs, this.d.memoryDir);
    } catch {
      return;
    }
    if (headers.length < threshold) return;
    const manifest = formatManifest(headers);
    const instruction = buildConsolidateInstruction(this.d.memoryDir, manifest);
    try {
      const merged = await this.d.forkRunner(parentMessages, instruction, gate, signal);
      if (merged.length > 0) {
        try {
          rebuildIndex(this.d.sandboxFs, this.d.memoryDir);
        } catch {
          /* 索引重建失败不影响已合并文件 */
        }
      }
    } catch {
      /* 蒸馏失败 best-effort,不影响主流程 */
    }
  }
}
