/**
 * soul cache-warm 提取驱动 —— turnEnd 经内核 `forkExtract` 复用上一轮缓存前缀做后台记忆抽取。
 *
 * 关键:`composeTurnRequest` 内部经 materializeNativeHistory 构建 host-owned history,且 systemPrompt
 * /tools 与上一轮 runTurn **同一构建器** → 一次调用即给齐「与上一轮字节对齐」的 systemPrompt+tools
 * +history,喂给 `kernel.forkExtract`,整段前缀走 cache-read(对齐 cc runForkedAgent)。
 *
 * 内核支持 forkExtract(forgeax-core)→ cache-warm;不支持(codex 等)/无会话/异常 → 返回 false,
 * 由调用方(runAutoExtract)回落冷链路(§9 graceful degradation)。fork 内模型经 `remember` 工具
 * 写 soul 分层记忆(host 桥 → classifyAndWrite);user 类暂以 kind:'general' 落 traits(始终载入)。
 *
 * Boundary(HOST 层):相对 import + @forgeax/agent-runtime 契约。
 */
import type { ForkExtractRequest, ForkExtractResult } from '@forgeax/agent-runtime';
import { resolveKernel } from '../kernel/resolve-kernel';
import { composeTurnRequest } from '../kernel/compose-turn-request';

/** 追加给 fork 的唯一一条 user 指令(英文,分层 taxonomy 经 remember 工具)。 */
export const SOUL_EXTRACT_INSTRUCTION = [
  'You are now acting as the memory extraction subagent. Analyze the most recent messages of the conversation above',
  'and persist durable memories using the `remember` tool — do not produce any other output.',
  '',
  "Use `remember` with kind:'general' for portable facts about the USER (their role, goals, preferences, how to work",
  "with them) AND for durable conventions/feedback; use kind:'game' for facts bound to the CURRENT game world.",
  '',
  'Do NOT save code, file paths, architecture, transient task state, or anything derivable from the project or git.',
  'Do NOT grep source files or run git to verify — only record durable facts from the recent conversation.',
  'Check existing memories (your long-term memory index is in the system prompt) and update rather than duplicate.',
  'If nothing is worth persisting, do nothing.',
].join('\n');

export interface SoulForkExtractInput {
  sid: string;
  /** 刚结束回合的 agent 路径(emitterId)。 */
  agentPath: string;
  signal?: AbortSignal;
}

/**
 * 尝试 cache-warm fork 提取。返回 true = 已由内核 fork 处理(调用方跳过冷链路);
 * false = 内核不支持 / 无会话 / 失败 → 调用方回落冷链路。
 */
export async function tryKernelForkExtract(input: SoulForkExtractInput): Promise<boolean> {
  let kernel;
  try {
    kernel = resolveKernel(input.agentPath);
  } catch {
    return false; // 无可用内核 → 冷兜底
  }
  if (!kernel.capabilities?.forkExtract || typeof kernel.forkExtract !== 'function') return false;

  // 复用上一轮的 systemPrompt+tools+history(同一 composeTurnRequest 构建器 → 缓存对齐)。
  let composed;
  try {
    composed = await composeTurnRequest({
      message: SOUL_EXTRACT_INSTRUCTION,
      agentId: input.agentPath,
      threadId: input.sid,
      sessionId: input.sid,
    });
  } catch {
    return false;
  }
  // 没有真实历史 → 多半是空会话 / 仅内部回合,不值得 fork。
  if (!composed.history || !composed.history.some((m) => m.role === 'user')) return false;

  const req: ForkExtractRequest = {
    session: composed.session,
    systemPrompt: composed.systemPrompt,
    tools: composed.tools ?? [],
    history: composed.history,
    instruction: SOUL_EXTRACT_INSTRUCTION,
    allowedTools: ['remember', 'memory_search'],
    hostSessionId: input.sid,
    ...(composed.model ? { model: composed.model } : {}),
  };
  try {
    const res: ForkExtractResult = await kernel.forkExtract(req, input.signal ?? AbortSignal.timeout(60_000));
    // fork 已处理本轮 ⇔ 它**真的写了/调了记忆工具**。仅 ok(=fork 完成)不够:fork 可能跑完却
    // 没调 remember(无可记)或 remember 被拦——此时若仍跳冷链路,本轮记忆就丢了。soul 经 remember
    // 写时 writtenPaths 为空、用 toolCalls 计数(见 @forgeax/agent-runtime contract 的
    // ForkExtractResult.toolCalls),故二者取或。
    return !!(res?.ok && (((res.toolCalls ?? 0) > 0) || ((res.writtenPaths?.length ?? 0) > 0)));
  } catch {
    return false; // RPC/运行期失败 → 冷兜底
  }
}
