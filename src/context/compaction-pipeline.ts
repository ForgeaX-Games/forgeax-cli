/**
 * Compaction pipeline (Stream E / #5·#12) — 三层管线编排,产单条 replacement 供 ledger fold。
 *
 *   L1 确定性瘦身(deterministic-compact:剥图/omit tool结果/大参数)
 *      ↓ 估 token
 *   sufficiency 短路(#12):L1 后已 ≤ effective×ratio → **不调 LLM**,用确定性骨架产 replacement
 *      ↓ 否则
 *   L2 LLM 摘要(host summarize;scenario prompt)
 *      ↓ summarize 抛 PTL → head-drop 重试(≤MAX_PTL_RETRIES);抛非 PTL → 上抛(E 回滚 + 熔断++)
 *   L3 PTL 兜底(在 summarizeWithPTLRetry 内)
 *
 * 两路都产 **单条 replacement** 覆盖 [coveredFrom..coveredTo],经 CompactionApplied → fold(可逆)。
 * 保留尾部 messagesToKeep 条不进压缩范围;边界安全:范围尾不以孤儿 tool_result 起头。
 *
 * 纯编排 + 注入 summarize(core 不自调 LLM)。Boundary: 仅 import core-local 类型。
 */
import type { ProviderMessage } from '../provider/types';
import type { CompactPipelineInput, CompactPipelineResult } from './compaction-types';
import { deterministicCompact, isSufficient, estimateTokens } from './deterministic-compact';
import {
  getCompactUserSummaryMessage,
  truncateHeadForPTLRetry,
  MAX_PTL_RETRIES,
  MAX_OVERSIZED_SUMMARY_DEPTH,
  PTL_RETRY_MARKER,
  ProviderSummaryError,
  isRecoverableSummaryOutput,
  splitOversizedMessageForSummary,
} from './compaction-llm';
import { isPromptTooLong } from './reactive-recovery';
import { hasToolResult } from './tool-pairing';

/** 确定性骨架的固定 header(单 run 内唯一;de-nest 时据此剥旧 header,防多次压缩 header 堆叠)。 */
export const DETERMINISTIC_SUMMARY_HEADER = 'Summary of the conversation so far (deterministic compaction — no LLM):';

/** One compaction attempt may branch while reducing an oversized message, but
 * every provider request in that tree consumes this single shared budget.
 *
 * A fully expanded binary tree at depth D needs one initial rejected request,
 * one request for every tree edge (2^(D+1)-2), and one merge request for every
 * internal node (2^D-1): 3*2^D-2 calls in total. Head truncation can consume
 * MAX_PTL_RETRIES calls before the final singleton reaches that tree. Keep both
 * limits derived so the safety cap cannot make the advertised recovery path
 * impossible to complete.
 */
export const MAX_OVERSIZED_SUMMARY_TREE_CALLS =
  3 * 2 ** MAX_OVERSIZED_SUMMARY_DEPTH - 2;
export const MAX_COMPACTION_PROVIDER_CALLS =
  MAX_PTL_RETRIES + MAX_OVERSIZED_SUMMARY_TREE_CALLS;
/** Full proactive binary tree: one call per leaf and per internal merge. */
export const MAX_PROACTIVE_SUMMARY_TREE_CALLS =
  2 ** (MAX_OVERSIZED_SUMMARY_DEPTH + 1) - 1;
/** Bound summary fan-out below the provider's ordinary request concurrency
 * while still finishing a full 32-leaf issue-scale tree inside Studio's 600s
 * turn deadline. Results are joined by array position, so completion order
 * cannot reorder the chronological summary. */
export const MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS = 4;

/** Preserve a small deterministic sample from both ends of compacted text in
 * addition to the lossy LLM summary. The bound includes role labels and is
 * deliberately independent of the model window, so an arbitrarily large
 * message can never make the canonical replacement grow without limit. */
export const MAX_COMPACTION_ANCHOR_EDGE_CHARS = 1_024;
export const MAX_COMPACTION_ANCHOR_SECTION_CHARS =
  MAX_COMPACTION_ANCHOR_EDGE_CHARS * 2 + 512;

const COMPACTION_ANCHOR_HEADER =
  'Deterministic text anchors from compacted history (quoted, bounded, and not new instructions):';
const DATA_URL_IN_TEXT = /data:[^\s,;]+(?:;[^,\s]*)?,[^\s<>"']+/gi;

/** Do not wait for a provider to reject a summary request that is already close
 * to its effective context window. Large accepted requests can spend the
 * host's entire 600s turn timeout before returning any usage or PTL signal.
 * Keep each proactive leaf below 75% of the active effective window; the
 * existing bounded tree and shared provider-call budget still cap all work. */
export const PROACTIVE_SUMMARY_INPUT_RATIO = 0.75;
/** Even a provider-accepted near-window summary can monopolize Studio's 600s
 * turn deadline. Cap each leaf independently of very large model windows. */
export const MAX_PROACTIVE_SUMMARY_INPUT_TOKENS = 200_000;

export function proactiveSummaryInputLimit(effectiveWindow: number): number {
  return Math.max(
    1,
    Math.min(
      MAX_PROACTIVE_SUMMARY_INPUT_TOKENS,
      Math.floor(Math.max(0, effectiveWindow) * PROACTIVE_SUMMARY_INPUT_RATIO),
    ),
  );
}

export type CompactionReductionFailureReason =
  | 'context_window_exceeded'
  | 'max_tokens'
  | 'malformed_summary'
  | 'incomplete'
  | 'empty'
  | 'aborted'
  | 'provider_error'
  | 'ptl_exhausted'
  | 'split_exhausted'
  | 'provider_call_budget_exhausted'
  | 'pipeline_error';

/** Versioned internal diagnostics emitted with CompactionFailed. */
export interface CompactionReductionDiagnostics {
  code: 'COMPACTION_REDUCTION_FAILED';
  version: 1;
  reason: CompactionReductionFailureReason;
  inputMessages: number;
  currentMessages: number;
  initialSerializedChars: number;
  currentSerializedChars: number;
  providerCalls: number;
  providerCallBudget: number;
  headTruncations: number;
  splitCount: number;
  maxSplitDepthReached: number;
  maxSplitDepth: number;
}

type ReductionState = Omit<CompactionReductionDiagnostics, 'code' | 'version' | 'reason'>;

export class CompactionReductionError extends Error {
  readonly code = 'COMPACTION_REDUCTION_FAILED';

  constructor(
    message: string,
    public readonly diagnostics: CompactionReductionDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CompactionReductionError';
  }
}

function serializedChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function reductionReason(error: unknown): CompactionReductionFailureReason {
  if (error instanceof ProviderSummaryError) return error.summaryFailureReason;
  return 'provider_error';
}

function reductionError(
  error: unknown,
  reason: CompactionReductionFailureReason,
  state: ReductionState,
): CompactionReductionError {
  if (error instanceof CompactionReductionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CompactionReductionError(
    message,
    { code: 'COMPACTION_REDUCTION_FAILED', version: 1, reason, ...state },
    error instanceof Error ? { cause: error } : undefined,
  );
}

interface ProviderCallSemaphore {
  acquire(signal: AbortSignal): Promise<() => void>;
}

function createProviderCallSemaphore(limit: number): ProviderCallSemaphore {
  let active = 0;
  const queue: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    onAbort: () => void;
  }> = [];

  const grantNext = (): void => {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new Error('compaction aborted'));
        continue;
      }
      active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active--;
        grantNext();
      });
    }
  };

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(new Error('compaction aborted'));
      return new Promise((resolve, reject) => {
        const waiter = {
          signal,
          resolve,
          reject,
          onAbort: () => {
            const index = queue.indexOf(waiter);
            if (index >= 0) queue.splice(index, 1);
            reject(new Error('compaction aborted'));
          },
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
        queue.push(waiter);
        grantNext();
      });
    },
  };
}

/** Always returns the same diagnostics shape, including for non-pipeline errors. */
export function compactionFailureDiagnostics(
  error: unknown,
  messages: readonly ProviderMessage[],
): CompactionReductionDiagnostics {
  if (error instanceof CompactionReductionError) return error.diagnostics;
  const chars = serializedChars(messages);
  return {
    code: 'COMPACTION_REDUCTION_FAILED',
    version: 1,
    reason: error instanceof ProviderSummaryError ? error.summaryFailureReason : 'pipeline_error',
    inputMessages: messages.length,
    currentMessages: messages.length,
    initialSerializedChars: chars,
    currentSerializedChars: chars,
    providerCalls: 0,
    providerCallBudget: MAX_COMPACTION_PROVIDER_CALLS,
    headTruncations: 0,
    splitCount: 0,
    maxSplitDepthReached: 0,
    maxSplitDepth: MAX_OVERSIZED_SUMMARY_DEPTH,
  };
}

/** 一条消息是否为「上一轮压缩产出的摘要」(确定性或 LLM 路都会打 `_compactionSummary` 标记)。 */
export function isPriorCompactionSummary(m: unknown): boolean {
  return !!(m && typeof m === 'object' && (m as Record<string, unknown>)._compactionSummary === true);
}

/** 剥掉确定性骨架的 header 行(若存在),返回其内层结构(已含 <previous_*> 包裹,不再重包)。 */
export function stripDeterministicHeader(content: string): string {
  const idx = content.indexOf(DETERMINISTIC_SUMMARY_HEADER);
  if (idx >= 0) return content.slice(idx + DETERMINISTIC_SUMMARY_HEADER.length).trimStart();
  return content;
}

/** 把 L1 瘦身后的前缀渲染成确定性骨架文本(sufficiency 短路时替代 LLM 摘要)。
 *  结构采用 previous_* 标签,但仅保骨架、零 LLM。
 *
 *  ★ de-nest(防多次压缩递归折叠):若某条是**上一轮压缩摘要**(`_compactionSummary`),
 *  **不再重包** `<previous_*>` —— 剥掉它的旧 header 后**原样并入**其内层(确定性摘要的内层已是
 *  `<previous_*>` 包裹;LLM 摘要内层是续接文本)。 */
export function renderDeterministicSummary(messages: readonly ProviderMessage[]): string {
  const lines: string[] = [DETERMINISTIC_SUMMARY_HEADER, ''];
  for (const m of messages) {
    const rec = m as unknown as Record<string, unknown>;
    // 旧压缩摘要 → de-nest:剥 header、原样并入内层,绝不二次包裹。
    if (isPriorCompactionSummary(m)) {
      const inner = stripDeterministicHeader(typeof rec.content === 'string' ? rec.content : '');
      if (inner.trim()) lines.push(inner);
      continue;
    }
    const role = rec.role;
    const content = rec.content;
    const text = typeof content === 'string' ? content : renderBlocks(content);
    if (!text.trim()) continue;
    if (role === 'user') lines.push(`<previous_user_message>\n${text}\n</previous_user_message>`);
    else if (role === 'assistant') lines.push(`<previous_assistant_message>\n${text}\n</previous_assistant_message>`);
    else lines.push(text);
  }
  return lines.join('\n');
}

function renderBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'tool_use') out.push(`[tool_call ${String(b.name ?? 'unknown')} ${jsonish(b.input)}]`);
    else if (b.type === 'tool_result') out.push(`[tool_result: ${truncate(String((b as any).content ?? ''), 200)}]`);
  }
  return out.join('\n');
}

function jsonish(v: unknown): string {
  try {
    return truncate(JSON.stringify(v ?? {}), 300);
  } catch {
    return '{}';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

interface CompactionTextFragment {
  role: string;
  text: string;
}

/** Extract only text from L1 output. Media/base64 blocks, tool calls, and tool
 * results are intentionally not traversed, so deterministic anchors cannot
 * re-persist payloads that L1 removed or disturb tool-use/result pairing. */
function compactionTextFragments(
  messages: readonly ProviderMessage[],
): CompactionTextFragment[] {
  const fragments: CompactionTextFragment[] = [];
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role : 'unknown';
    const content = record.content;
    if (typeof content === 'string') {
      const text = sanitizeCompactionAnchorText(content);
      if (text.trim()) fragments.push({ role, text });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const candidate = block as Record<string, unknown>;
      if (candidate?.type !== 'text' || typeof candidate.text !== 'string') continue;
      const text = sanitizeCompactionAnchorText(candidate.text);
      if (text.trim()) fragments.push({ role, text });
    }
  }
  return fragments;
}

function sanitizeCompactionAnchorText(text: string): string {
  return text.replace(DATA_URL_IN_TEXT, '[data URL omitted in compaction anchor]');
}

function renderHeadAnchor(fragments: readonly CompactionTextFragment[]): string {
  let output = '';
  for (const fragment of fragments) {
    const prefix = `${output ? '\n' : ''}[${fragment.role}] `;
    const remaining = MAX_COMPACTION_ANCHOR_EDGE_CHARS - output.length;
    if (remaining <= prefix.length) break;
    const text = fragment.text.slice(0, remaining - prefix.length);
    output += prefix + text;
    if (text.length < fragment.text.length) break;
  }
  return output;
}

function renderTailAnchor(fragments: readonly CompactionTextFragment[]): string {
  let output = '';
  for (let index = fragments.length - 1; index >= 0; index--) {
    const fragment = fragments[index]!;
    const separator = output ? '\n' : '';
    const label = `[${fragment.role}] `;
    const remaining =
      MAX_COMPACTION_ANCHOR_EDGE_CHARS - output.length - separator.length - label.length;
    if (remaining <= 0) break;
    const text = fragment.text.slice(-remaining);
    output = `${label}${text}${separator}${output}`;
    if (text.length < fragment.text.length) break;
  }
  return output;
}

/** Render chronological, role-labelled head/tail anchors from already-stripped
 * L1 messages. The result has a hard character ceiling and contains text only. */
export function renderDeterministicTextAnchors(
  messages: readonly ProviderMessage[],
): string {
  const fragments = compactionTextFragments(messages);
  if (fragments.length === 0) return '';
  const head = renderHeadAnchor(fragments);
  const tail = renderTailAnchor(fragments);
  const section = `${COMPACTION_ANCHOR_HEADER}\n<compacted_text_head>\n${head}\n</compacted_text_head>\n<compacted_text_tail>\n${tail}\n</compacted_text_tail>`;
  // Keep the limit executable as an invariant if labels change in the future.
  if (section.length > MAX_COMPACTION_ANCHOR_SECTION_CHARS) {
    throw new Error('Compaction anchor section exceeded its hard character limit.');
  }
  return section;
}

/** Carve 待压前缀(保留尾 messagesToKeep),边界安全回退避免孤儿 tool_result。返回 exclusive 上界。 */
function carveSummarizeUpTo(messages: readonly ProviderMessage[], messagesToKeep: number): number {
  const keep = Math.min(Math.max(0, messagesToKeep), Math.max(0, messages.length - 1));
  let upTo = messages.length - keep;
  while (upTo > 1 && upTo < messages.length && hasToolResult(messages[upTo])) upTo--;
  return upTo;
}

/** L2:调 summarize,PTL → head-drop 重试(≤MAX_PTL_RETRIES);非 PTL 上抛。 */
async function summarizeWithPTLRetry(
  messages: readonly ProviderMessage[],
  scenario: CompactPipelineInput['scenario'],
  summarize: CompactPipelineInput['summarize'],
  maxSummaryInputTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const attemptController = new AbortController();
  const abortAttempt = (): void => attemptController.abort(signal?.reason);
  if (signal?.aborted) abortAttempt();
  else signal?.addEventListener('abort', abortAttempt, { once: true });
  const attemptSignal = attemptController.signal;
  const providerSlots = createProviderCallSemaphore(
    MAX_CONCURRENT_COMPACTION_PROVIDER_CALLS,
  );
  let current: readonly ProviderMessage[] = messages;
  let attempts = 0;
  const initialSerializedChars = serializedChars(messages);
  const state: ReductionState = {
    inputMessages: messages.length,
    currentMessages: messages.length,
    initialSerializedChars,
    currentSerializedChars: initialSerializedChars,
    providerCalls: 0,
    providerCallBudget: MAX_COMPACTION_PROVIDER_CALLS,
    headTruncations: 0,
    splitCount: 0,
    maxSplitDepthReached: 0,
    maxSplitDepth: MAX_OVERSIZED_SUMMARY_DEPTH,
  };
  let primaryFailure: CompactionReductionError | undefined;
  const callSummary = async (input: readonly ProviderMessage[]): Promise<string> => {
    let release: (() => void) | undefined;
    try {
      try {
        release = await providerSlots.acquire(attemptSignal);
      } catch (error) {
        throw reductionError(error, 'aborted', state);
      }
      if (attemptSignal.aborted) {
        throw reductionError(new Error('compaction aborted'), 'aborted', state);
      }
      // Keep the semaphore slot, shared call budget and signal across this
      // one retry. Hidden retries inside the provider adapter would undercount
      // calls, and recursively acquiring a slot could deadlock split branches.
      for (let outputRecovery = false; ; outputRecovery = true) {
        if (state.providerCalls >= state.providerCallBudget) {
          const error = reductionError(
            new Error(`compaction provider-call budget exhausted after ${state.providerCalls} calls`),
            'provider_call_budget_exhausted',
            state,
          );
          primaryFailure ??= error;
          abortAttempt();
          throw primaryFailure;
        }
        state.providerCalls++;
        state.currentMessages = input.length;
        state.currentSerializedChars = serializedChars(input);
        try {
          const result = await summarize(input, scenario, attemptSignal,
            outputRecovery ? { outputRecovery: true } : undefined);
          if (attemptSignal.aborted) {
            if (primaryFailure) throw primaryFailure;
            throw reductionError(new Error('compaction aborted'), 'aborted', state);
          }
          return result;
        } catch (error) {
          if (attemptSignal.aborted && primaryFailure) throw primaryFailure;
          if (!attemptSignal.aborted && !outputRecovery && isRecoverableSummaryOutput(error)) {
            continue;
          }
          if (isPromptTooLong(error)) throw error;
          const failure = reductionError(
            error,
            attemptSignal.aborted ? 'aborted' : reductionReason(error),
            state,
          );
          primaryFailure ??= failure;
          // Abort before releasing the slot so a terminal branch cannot admit
          // more queued work while its rejection propagates through Promise.all.
          abortAttempt();
          throw primaryFailure;
        }
      }
    } finally {
      release?.();
    }
  };

  try {
    // A provider may accept an enormous request but fail to answer before the
    // host timeout. Split locally when our conservative estimate is already near
    // the window instead of depending on a prompt-too-long response to arrive.
    if (estimateTokens(current) > maxSummaryInputTokens) {
      return await summarizeOversizedInput(
        current,
        callSummary,
        attemptSignal,
        state,
        0,
        maxSummaryInputTokens,
      );
    }
    for (;;) {
      try {
        return await callSummary(current);
      } catch (err) {
        if (attemptSignal.aborted) throw reductionError(err, 'aborted', state);
        if (!isPromptTooLong(err)) throw reductionError(err, reductionReason(err), state);
        attempts++;
        const truncated = attempts <= MAX_PTL_RETRIES ? truncateHeadForPTLRetry(current) : null;
        if (!truncated) {
          const withoutRetryMarker =
            current.length > 0 &&
            current[0]?.role === 'user' &&
            current[0]?.content === PTL_RETRY_MARKER
              ? current.slice(1)
              : current;
          if (withoutRetryMarker.length > 0) {
            return await summarizeOversizedInput(
              withoutRetryMarker,
              callSummary,
              attemptSignal,
              state,
              0,
              maxSummaryInputTokens,
            );
          }
          throw reductionError(err, 'ptl_exhausted', state);
        }
        current = truncated as ProviderMessage[];
        state.headTruncations++;
      }
    }
  } catch (error) {
    abortAttempt();
    throw primaryFailure ?? error;
  } finally {
    signal?.removeEventListener('abort', abortAttempt);
  }
}

function splitOversizedInputForSummary(
  messages: readonly ProviderMessage[],
): [ProviderMessage[], ProviderMessage[]] | null {
  if (messages.length === 0) return null;
  if (messages.length === 1) {
    const split = splitOversizedMessageForSummary(messages[0]!);
    return split ? [[split[0]], [split[1]]] : null;
  }

  const sizes = messages.map((message) => Math.max(1, serializedChars(message)));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let running = 0;
  let splitAt = 1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let index = 1; index < messages.length; index++) {
    running += sizes[index - 1]!;
    const delta = Math.abs(total - running * 2);
    if (delta < bestDelta) {
      bestDelta = delta;
      splitAt = index;
    }
  }
  // Keep an adjacent tool_use/tool_result pair on the same side. A boundary at
  // index 1 cannot move left without creating an empty partition, so move it
  // right when a third message exists. For an indivisible two-message pair,
  // fail closed instead of sending either orphan to the summary provider.
  while (splitAt > 1 && hasToolResult(messages[splitAt])) splitAt--;
  if (splitAt === 1 && hasToolResult(messages[splitAt])) {
    if (messages.length <= 2) {
      const pairedExchange: ProviderMessage = {
        role: 'user',
        content:
          '[paired tool exchange converted to text for bounded summary splitting]\n' +
          JSON.stringify(messages),
      };
      const pairedSplit = splitOversizedMessageForSummary(pairedExchange);
      return pairedSplit ? [[pairedSplit[0]], [pairedSplit[1]]] : null;
    }
    splitAt++;
  }
  return [messages.slice(0, splitAt), messages.slice(splitAt)];
}

/** Summarize both chronological halves of oversized input, then summarize their
 * summaries. Multi-message histories split at message boundaries; an
 * indivisible singleton uses the structural content splitter. Every recursive
 * edge strictly reduces serialized input, while depth and the attempt-wide
 * provider budget independently bound the tree. */
async function summarizeOversizedInput(
  messages: readonly ProviderMessage[],
  summarize: (messages: readonly ProviderMessage[]) => Promise<string>,
  signal: AbortSignal | undefined,
  state: ReductionState,
  depth: number,
  maxSummaryInputTokens: number,
): Promise<string> {
  if (signal?.aborted) {
    throw reductionError(new Error('compaction aborted'), 'aborted', state);
  }
  state.maxSplitDepthReached = Math.max(state.maxSplitDepthReached, depth);
  const split =
    depth < MAX_OVERSIZED_SUMMARY_DEPTH
      ? splitOversizedInputForSummary(messages)
      : null;
  if (!split) {
    throw reductionError(
      new Error(`compaction failed: summary input remains too large after ${depth} bounded content splits`),
      'split_exhausted',
      state,
    );
  }
  state.splitCount++;

  const summarizePart = async (part: readonly ProviderMessage[]): Promise<string> => {
    if (signal?.aborted) {
      throw reductionError(new Error('compaction aborted'), 'aborted', state);
    }
    if (estimateTokens(part) > maxSummaryInputTokens) {
      return summarizeOversizedInput(
        part,
        summarize,
        signal,
        state,
        depth + 1,
        maxSummaryInputTokens,
      );
    }
    try {
      return await summarize(part);
    } catch (err) {
      if (signal?.aborted) throw reductionError(err, 'aborted', state);
      if (!isPromptTooLong(err)) throw reductionError(err, reductionReason(err), state);
      return summarizeOversizedInput(
        part,
        summarize,
        signal,
        state,
        depth + 1,
        maxSummaryInputTokens,
      );
    }
  };

  const [left, right] = await Promise.all([
    summarizePart(split[0]),
    summarizePart(split[1]),
  ]);
  const merged: ProviderMessage = {
    role: 'user',
    content:
      '[oversized message chunk summaries; preserve facts from both in order]\n\n' +
      `<chunk_1>\n${left}\n</chunk_1>\n\n<chunk_2>\n${right}\n</chunk_2>`,
  };
  if (estimateTokens([merged]) > maxSummaryInputTokens) {
    return summarizeOversizedInput(
      [merged],
      summarize,
      signal,
      state,
      depth + 1,
      maxSummaryInputTokens,
    );
  }
  try {
    return await summarize([merged]);
  } catch (err) {
    if (signal?.aborted) throw reductionError(err, 'aborted', state);
    if (!isPromptTooLong(err)) throw reductionError(err, reductionReason(err), state);
    return summarizeOversizedInput(
      [merged],
      summarize,
      signal,
      state,
      depth + 1,
      maxSummaryInputTokens,
    );
  }
}

/**
 * 跑压缩管线,产 CompactPipelineResult。throw = 压缩失败(E 应回滚 + 熔断计数)。
 */
export async function runCompaction(input: CompactPipelineInput): Promise<CompactPipelineResult> {
  const { messages, marks, sufficiencyRatio, scenario, summarize, messagesToKeep } = input;
  if (messages.length === 0) throw new Error('Not enough messages to compact.');

  const upTo = carveSummarizeUpTo(messages, messagesToKeep);
  const prefix = messages.slice(0, upTo);
  if (prefix.length === 0) throw new Error('Not enough messages to compact.');

  // L1 确定性瘦身
  const l1 = deterministicCompact(prefix);
  const coveredTo = upTo - 1;

  // sufficiency 短路 → 确定性骨架,不调 LLM
  if (isSufficient(l1.estimatedTokens, marks.effectiveWindow, sufficiencyRatio)) {
    const content = renderDeterministicSummary(l1.messages as ProviderMessage[]);
    const replacement: ProviderMessage = {
      role: 'user',
      content,
      ...({ _compactionSummary: true, _deterministic: true, _coveredCount: prefix.length } as Record<string, unknown>),
    } as ProviderMessage;
    return { replacement, coveredFrom: 0, coveredTo, usedLLM: false, estimatedTokens: estimateTokens([replacement]) };
  }

  // L2 LLM 摘要(喂 L1 瘦身后的前缀,省 token)
  const summary = await summarizeWithPTLRetry(
    l1.messages as ProviderMessage[],
    scenario,
    summarize,
    proactiveSummaryInputLimit(marks.effectiveWindow),
    input.signal,
  );
  const anchors = renderDeterministicTextAnchors(l1.messages as ProviderMessage[]);
  const replacement: ProviderMessage = {
    role: 'user',
    content: [getCompactUserSummaryMessage(summary), anchors].filter(Boolean).join('\n\n'),
    ...({ _compactionSummary: true, _coveredCount: prefix.length } as Record<string, unknown>),
  } as ProviderMessage;
  return { replacement, coveredFrom: 0, coveredTo, usedLLM: true, estimatedTokens: estimateTokens([replacement]) };
}
