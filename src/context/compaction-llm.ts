/**
 * LLM-backed compaction strategy (C7) — the §12 ③ injectable strategy that
 * produces a *real* conversation summary instead of the deterministic
 * placeholder from `FoldCompactionStrategy`.
 *
 * 设计稿: 最终实现方案 §12 (CTX 拥有 compaction 引擎；真摘要 strategy 作 ③ 注入)。
 *   - shouldCompact —— 同 auto-compact 水位:tokenCount 越过 autoCompactThreshold
 *     即触发(与 FoldCompactionStrategy 一致,见 compaction.ts)。
 *   - compact —— 调注入的 `summarize(messages) → Promise<string>` 产摘要文本,
 *     包成一条 user 摘要消息(`getCompactUserSummaryMessage` 的前缀模板),
 *     再把它与「保留尾部 N 条」拼成 replacement,覆盖 [coveredFrom..coveredTo]。
 *   - PTL retry —— summarize 命中 prompt-too-long(error.message 以
 *     PROMPT_TOO_LONG_MESSAGE 开头)时,从头部丢弃最旧消息(truncateHead)后重试,
 *     最多 MAX_PTL_RETRIES(=3)次。
 *   - getCompactPrompt —— 摘要 prompt 模板,9 段(BASE_COMPACT_PROMPT)。
 *
 * core 不内置任何 LLM 调用:`summarize` 由 host 用 C4 provider 实现并注入
 * (留注入函数,见 LLMCompactionConfig.summarize)。core 只负责水位判定、范围计算、
 * PTL 重试编排与摘要消息成形。
 *
 * 与 ledger fold 的契合(skip-and-replace，§3.8.3 / history/ledger.ts):
 *   compact() 产 {replacement, coveredFrom, coveredTo};host 据此发一条
 *   CompactionApplied(range = byIndex[coveredFrom..coveredTo]，replacement = 摘要
 *   user 消息)。foldEvents 在该 range 第一条吐 replacement,其余跳过(可逆、审计友好)。
 *   "保留尾部 N 条"由 caller 决定切片:本 strategy 只压缩传入的 messages 前缀,
 *   把最近 messagesToKeep 条原样追加进 replacement 之外不动 —— 见 compact() 注释。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import {
  PROMPT_TOO_LONG_MESSAGE,
  type ProviderMessage,
  type LLMProvider,
  type ProviderCallOpts,
  type ProviderRequest,
  type StopReason,
} from '../provider/types';
import type { CompactionStrategy, Watermarks } from './types';
import type { SummaryScenario, CompactSummarize, SummaryRequestOptions } from './compaction-types';
import { startsWithToolResult } from './tool-pairing';
import { isPromptTooLong } from './reactive-recovery';

/** Max prompt-too-long retries for the compaction summary call. */
export const MAX_PTL_RETRIES = 3;

/** Maximum binary split depth used when a single message is itself too large
 * for the provider's summary request. Five levels cap the fallback at thirty-two
 * leaf summaries and make termination independent of provider behaviour.
 *
 * The extra level is required for a real 128k-window kernel: after reserving
 * output and applying the proactive 75% ceiling, a 6.84 MB singleton needs
 * more than sixteen leaves even though every split halves it correctly. */
export const MAX_OVERSIZED_SUMMARY_DEPTH = 5;

/** Synthetic marker prepended after a head-truncation PTL retry. */
export const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]';

/** Default number of recent messages preserved verbatim past the summary
 *  (a recent tail is kept post-compact; host may override via config). */
export const DEFAULT_MESSAGES_TO_KEEP = 0;

const SPLITTABLE_CONTENT_KEYS = new Set(['content', 'text', 'data']);
const TOOL_ARGUMENT_CONTAINER_KEYS = new Set(['input', 'args', 'arguments']);

type StringPayload = { path: Array<string | number>; value: string };

export type ProviderSummaryFailureReason =
  | 'context_window_exceeded'
  | 'max_tokens'
  | 'malformed_summary'
  | 'incomplete'
  | 'empty'
  | 'aborted';

/** A rejected provider summary response with a stable machine-readable reason. */
export class ProviderSummaryError extends Error {
  readonly code = 'COMPACTION_SUMMARY_REJECTED';

  constructor(
    public readonly summaryFailureReason: ProviderSummaryFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderSummaryError';
  }
}

/** Only output failures can use the single short-summary recovery attempt.
 * Incomplete transport, refusal, tools, empty output and cancellation are not
 * format errors, even if their text happens to contain an opening summary tag.
 */
export function isRecoverableSummaryOutput(error: unknown): boolean {
  return error instanceof ProviderSummaryError
    && (error.summaryFailureReason === 'max_tokens' || error.summaryFailureReason === 'malformed_summary');
}

/**
 * Split the largest content-bearing string in one provider message while
 * retaining the surrounding content-block metadata in both halves.
 *
 * This is deliberately a structural split, not a lossy truncation: callers
 * summarize both halves and then merge those summaries. It covers plain text,
 * text blocks, textual resource `data`, and large tool arguments. Binary image
 * payloads normally never arrive here because deterministic L1 replaces them
 * before the LLM summary stage.
 */
export function splitOversizedMessageForSummary(
  message: ProviderMessage,
): [ProviderMessage, ProviderMessage] | null {
  const payload = largestSplittableString(message, [], undefined);
  if (!payload || payload.value.length < 2) return null;

  let middle = Math.floor(payload.value.length / 2);
  // Do not split a UTF-16 surrogate pair.
  const before = payload.value.charCodeAt(middle - 1);
  const after = payload.value.charCodeAt(middle);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) middle++;

  const [first, second] = splitAtPath(
    message,
    payload.path,
    payload.value.slice(0, middle),
    payload.value.slice(middle),
  );
  const originalSize = JSON.stringify(message).length;
  const firstChunk = { ...first, _compactionChunk: { part: 1, total: 2 } } as ProviderMessage;
  const secondChunk = { ...second, _compactionChunk: { part: 2, total: 2 } } as ProviderMessage;
  if (
    JSON.stringify(firstChunk).length >= originalSize ||
    JSON.stringify(secondChunk).length >= originalSize
  ) {
    return null;
  }
  return [firstChunk, secondChunk];
}

function largestSplittableString(
  value: unknown,
  path: Array<string | number>,
  key: string | undefined,
  insideToolArguments = false,
): StringPayload | null {
  if (typeof value === 'string') {
    return insideToolArguments || (key !== undefined && SPLITTABLE_CONTENT_KEYS.has(key))
      ? { path, value }
      : null;
  }
  if (Array.isArray(value)) {
    let best: StringPayload | null = null;
    for (let i = 0; i < value.length; i++) {
      const candidate = largestSplittableString(value[i], [...path, i], key, insideToolArguments);
      if (candidate && (!best || candidate.value.length > best.value.length)) best = candidate;
    }
    return best;
  }
  if (typeof value !== 'object' || value === null) return null;

  let best: StringPayload | null = null;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    const candidate = largestSplittableString(
      child,
      [...path, childKey],
      childKey,
      insideToolArguments || TOOL_ARGUMENT_CONTAINER_KEYS.has(childKey),
    );
    if (candidate && (!best || candidate.value.length > best.value.length)) best = candidate;
  }
  return best;
}

function hasSplittablePayload(
  value: unknown,
  key: string | undefined,
  insideToolArguments: boolean,
): boolean {
  return largestSplittableString(value, [], key, insideToolArguments) !== null;
}

/**
 * Partition every semantic sibling along the selected leaf's path. Array
 * siblings and other splittable payload fields go to exactly one side; only
 * envelope metadata (role, type, name, ids, MIME information, etc.) repeats.
 */
function splitAtPath<T>(
  value: T,
  path: readonly (string | number)[],
  leftReplacement: string,
  rightReplacement: string,
  insideToolArguments = false,
): [T, T] {
  if (path.length === 0) return [leftReplacement as T, rightReplacement as T];
  const [head, ...tail] = path;
  if (Array.isArray(value)) {
    const index = head as number;
    const [leftChild, rightChild] = splitAtPath(
      value[index],
      tail,
      leftReplacement,
      rightReplacement,
      insideToolArguments,
    );
    return [
      [...value.slice(0, index), leftChild] as T,
      [rightChild, ...value.slice(index + 1)] as T,
    ];
  }
  const record = value as Record<string, unknown>;
  const targetKey = String(head);
  const targetInsideToolArguments =
    insideToolArguments || TOOL_ARGUMENT_CONTAINER_KEYS.has(targetKey);
  const [leftChild, rightChild] = splitAtPath(
    record[targetKey],
    tail,
    leftReplacement,
    rightReplacement,
    targetInsideToolArguments,
  );
  const left: Record<string, unknown> = {};
  const right: Record<string, unknown> = {};
  let beforeTarget = true;
  for (const [key, child] of Object.entries(record)) {
    if (key === targetKey) {
      left[key] = leftChild;
      right[key] = rightChild;
      beforeTarget = false;
    } else if (
      hasSplittablePayload(
        child,
        key,
        insideToolArguments || TOOL_ARGUMENT_CONTAINER_KEYS.has(key),
      )
    ) {
      (beforeTarget ? left : right)[key] = child;
    } else {
      left[key] = child;
      right[key] = child;
    }
  }
  return [left as T, right as T];
}

// ─── summarize injection ──────────────────────────────────────────────────────

/** Host-provided summarizer: turn a slice of messages into a summary string.
 *  Implemented by the host using a C4 provider (core never calls an LLM itself).
 *  Throw an Error whose `message` starts with PROMPT_TOO_LONG_MESSAGE to signal
 *  the compact request itself overflowed — the strategy will head-truncate and
 *  retry. Any other throw aborts compaction (propagated to the caller). */
export type Summarize = (messages: readonly unknown[], signal?: AbortSignal, options?: SummaryRequestOptions) => Promise<string>;

export interface LLMCompactionConfig {
  /** Host summarizer (required). */
  summarize: Summarize;
  /** Recent messages to preserve verbatim outside the summarized range.
   *  Default 0 — caller typically slices the prefix to compact and keeps the
   *  tail itself; set > 0 to have the strategy carve the tail internally. */
  messagesToKeep?: number;
  /** Optional custom compaction instructions appended to the summary prompt. */
  customInstructions?: string;
  /** Optional transcript path surfaced in the summary message footer. */
  transcriptPath?: string;
}

// ─── prompt template (BASE_COMPACT_PROMPT, 9 sections) ───────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text in one complete summary block.

`;

const BASE_COMPACT_PROMPT = `Your task is to create a compact but complete continuation summary of the conversation so far.
Preserve the facts needed to resume the work, but stay under 1,500 output tokens so the result finishes cleanly. Do not reproduce long messages, logs, generated data, or full source files. Use short excerpts only when an exact string is essential.

Return exactly one <summary>...</summary> block and no other text.

Preserve observed tool facts with their exact paths and API names, including failed lookups, unsupported APIs, and error outcomes. Keep failures distinct from successful reads; a requested path is not proof it exists. Carry forward still-relevant facts from earlier summaries. Tool excerpts may be truncated: do not infer success or missing details from omitted content.

Preserve the facts needed to continue the work, using these sections:

1. Primary Request and Intent: the user's requests, constraints, corrections, and desired outcome.
2. Key Technical Concepts: important technologies, contracts, decisions, and terminology.
3. Files and Code Sections: files, symbols, commands, edits, and code details that matter for continuation.
4. Errors and fixes: observed failures, evidence, fixes attempted, and their results.
5. Problem Solving: completed work and unresolved investigation.
6. All user messages: every user instruction that changes or constrains the work, without copying long messages.
7. Pending Tasks: unfinished tasks explicitly requested by the user.
8. Current Work: the exact state immediately before this summary request.
9. Optional Next Step: only the next action directly supported by the latest user request.

Keep exact identifiers, paths, values, requested reply strings, and other details whose loss could change the continuation.`;

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'one complete summary block and no other blocks. ' +
  'Tool calls will be rejected and you will fail the task.';

/** Pre-message-compaction preamble (#2/#11):压完后紧接一条新的用户消息,摘要要让模型无缝接上。 */
const PRE_MESSAGE_COMPACT_PREAMBLE = `This summary will be placed at the start of a continuing session. A NEW user message will follow immediately. Preserve the earlier state needed to respond correctly to that message.

`;

/** Build the compaction summary prompt (`getCompactPrompt`).
 *  按 scenario 选模板(#2):
 *   - 'full'        —— 全量 9 段(默认,行为同旧)。
 *   - 'pre-message' —— 压后紧跟新用户消息的预压场景。
 *  统一裹 no-tools preamble/trailer;可选 customInstructions 追加。 */
export function getCompactPrompt(scenario: SummaryScenario = 'full', customInstructions?: string, options?: SummaryRequestOptions): string {
  const scenarioPreamble = scenario === 'pre-message' ? PRE_MESSAGE_COMPACT_PREAMBLE : '';
  const summaryPrompt = options?.outputRecovery
    ? `The previous summary was truncated or did not produce a complete summary block. Create a shorter continuation summary from the same complete history.
Return exactly one <summary>...</summary> block, under 600 output tokens. Use concise bullets, not a nine-section report.
Preserve the current user goal, constraints, exact identifiers and values, completed changes, unresolved errors, and next action. Omit repetitive logs and reference records.
Preserve relationships between facts and chronological corrections. Do not invent conflicts or separate projects when the user explicitly refers to earlier messages. If details cannot fit, retain the facts necessary to continue the latest request.`
    : BASE_COMPACT_PROMPT;
  let prompt = NO_TOOLS_PREAMBLE + scenarioPreamble + summaryPrompt;
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }
  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

// ─── summary formatting (formatCompactSummary / userSummaryMessage) ─

/** Strip the <analysis> scratchpad and unwrap the <summary> block into readable
 *  text (`formatCompactSummary`). Falls back to the raw text when no tags. */
export function formatCompactSummary(summary: string): string {
  let out = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const m = out.match(/<summary>([\s\S]*?)<\/summary>/);
  if (m) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(m[1] ?? '').trim()}`);
  }
  out = out.replace(/\n\n+/g, '\n\n');
  return out.trim();
}

/** Wrap a formatted summary into the post-compact continuation user message
 *  (`getCompactUserSummaryMessage`). */
export function getCompactUserSummaryMessage(summary: string, transcriptPath?: string): string {
  const formatted = formatCompactSummary(summary);
  let base = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formatted}`;
  if (transcriptPath) {
    base += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
  }
  return base;
}

// ─── PTL head-truncation (truncateHeadForPTLRetry) ──────────────

/** Fraction of the oldest messages dropped per PTL retry. Halving (vs the old
 *  20%) lets a summary prompt that overflows by several× the window converge
 *  within MAX_PTL_RETRIES instead of throwing: 0.5³ ≈ 0.125, so a ~5× overflow
 *  recovers in 3 retries. We only ever drop the OLDEST turns, and only when the
 *  summary prompt itself overflows — context loss there is unavoidable. */
export const PTL_HEAD_DROP_FRACTION = 0.5;

/** Drop the oldest ~50% of messages and prepend a synthetic marker so the next
 *  retry summarizes a smaller prefix. Returns null when nothing can be dropped
 *  without emptying the set (caller then gives up).
 *
 *  Provider-neutral simplification of api-round grouping: core treats the
 *  message list as flat. The marker is a `{ role:'user', content }` shape so the
 *  truncated prefix still starts with a user turn (API requires role=user first).
 */
export function truncateHeadForPTLRetry(messages: readonly unknown[]): unknown[] | null {
  // Strip our own marker from a prior retry so progress isn't stalled.
  const input =
    messages.length > 0 && isMarkerMessage(messages[0]) ? messages.slice(1) : messages.slice();
  if (input.length < 2) return null;

  const dropCount = Math.min(
    Math.max(1, Math.floor(input.length * PTL_HEAD_DROP_FRACTION)),
    input.length - 1,
  );
  const sliced = input.slice(dropCount);
  return [{ role: 'user', content: PTL_RETRY_MARKER }, ...sliced];
}

function isMarkerMessage(m: unknown): boolean {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { role?: unknown }).role === 'user' &&
    (m as { content?: unknown }).content === PTL_RETRY_MARKER
  );
}

// ─── strategy ─────────────────────────────────────────────────────────────────

/**
 * LLM-backed compaction strategy.
 *
 * shouldCompact: token-watermark gate identical to auto-compact / the default
 * fold strategy — fire once tokenCount reaches autoCompactThreshold.
 *
 * compact: summarize the compactable prefix via the injected `summarize`, retry
 * with head-truncation on prompt-too-long (≤ MAX_PTL_RETRIES), then build a
 * replacement covering that prefix. When `messagesToKeep > 0` the trailing N
 * messages are excluded from the summarized range (preserved verbatim by the
 * caller) and the covered range stops before them.
 */
export class LLMCompactionStrategy implements CompactionStrategy {
  readonly name = 'llm';

  private readonly summarize: Summarize;
  private readonly messagesToKeep: number;
  private readonly customInstructions?: string;
  private readonly transcriptPath?: string;

  constructor(config: LLMCompactionConfig) {
    if (typeof config.summarize !== 'function') {
      throw new Error('LLMCompactionStrategy requires a summarize() function (host injects it)');
    }
    this.summarize = config.summarize;
    this.messagesToKeep = Math.max(0, config.messagesToKeep ?? DEFAULT_MESSAGES_TO_KEEP);
    this.customInstructions = config.customInstructions;
    this.transcriptPath = config.transcriptPath;
  }

  shouldCompact(tokenCount: number, marks: Watermarks): boolean {
    return tokenCount >= marks.autoCompactThreshold;
  }

  async compact(
    messages: unknown[],
    signal?: AbortSignal,
  ): Promise<{ replacement: unknown; coveredFrom: number; coveredTo: number }> {
    if (messages.length === 0) {
      throw new Error('Not enough messages to compact.');
    }

    // Carve the recent tail to preserve (messagesToKeep). The summarized
    // range covers only the prefix; the tail stays verbatim for the caller.
    const keep = Math.min(this.messagesToKeep, Math.max(0, messages.length - 1));
    let summarizeUpTo = messages.length - keep; // exclusive end of compacted prefix
    // ★ 边界安全(adjustIndexToPreserveAPIInvariants):保留尾部不得以孤儿
    //   tool_result 起头(其 tool_use 已被摘进 summary)。边界回退,把整对一起留进尾部,
    //   不劈开、不丢 tool_result。至少摘 1 条。
    while (
      summarizeUpTo > 1 &&
      summarizeUpTo < messages.length &&
      startsWithToolResult(messages[summarizeUpTo] as ProviderMessage)
    ) {
      summarizeUpTo--;
    }
    const toSummarize = messages.slice(0, summarizeUpTo);
    if (toSummarize.length === 0) {
      throw new Error('Not enough messages to compact.');
    }

    const summary = await this.runSummarizeWithPTLRetry(toSummarize, signal);

    const replacement = {
      role: 'user' as const,
      content: getCompactUserSummaryMessage(summary, this.transcriptPath),
      // markers so downstream can recognize a real LLM summary message.
      _compactionSummary: true,
      _coveredCount: toSummarize.length,
    };

    return { replacement, coveredFrom: 0, coveredTo: summarizeUpTo - 1 };
  }

  /** Call summarize, head-truncating + retrying on prompt-too-long up to
   *  MAX_PTL_RETRIES. */
  private async runSummarizeWithPTLRetry(
    messages: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<string> {
    let current = messages;
    let attempts = 0;
    let outputRecovery = false;
    for (; ;) {
      try {
        return await this.summarize(current, signal, outputRecovery ? { outputRecovery: true } : undefined);
      } catch (err) {
        if (!signal?.aborted && !outputRecovery && isRecoverableSummaryOutput(err)) {
          outputRecovery = true;
          continue;
        }
        if (!isPromptTooLong(err)) throw err;
        attempts++;
        const truncated = attempts <= MAX_PTL_RETRIES ? truncateHeadForPTLRetry(current) : null;
        if (!truncated) {
          throw err instanceof Error
            ? err
            : new Error('Conversation too long — compaction failed.');
        }
        current = truncated;
      }
    }
  }
}

// ─── provider-backed summarize / compaction(host 复用;干净律:用注入 provider,非硬编码 LLM)──

/** 用注入 provider 跑摘要(streamCompactSummary,maxTurns:1)。
 *  self-limit(#3):tools 为空(不会再调工具/触发子压缩)+ maxOutputTokens 固定上限,
 *  单次非 agentic 调用。`scenario` 选 prompt 模板(#2)。 */
export function makeProviderSummarize(
  provider: LLMProvider,
  model: string,
  scenario: SummaryScenario = 'full',
  customInstructions?: string,
  boundaryTrace?: ProviderCallOpts['boundaryTrace'],
): Summarize {
  return async (messages, signal = new AbortController().signal, options) => {
    throwIfSummaryAborted(signal);
    const req: ProviderRequest = {
      model,
      system: [{ type: 'text', text: getCompactPrompt(scenario, customInstructions, options) }],
      tools: [], // self-limit:无工具 → 摘要不会再触发任何工具/递归压缩
      messages: [{ role: 'user', content: messages.map((m) => JSON.stringify(m)).join('\n') }],
      maxOutputTokens: options?.outputRecovery
        ? COMPACTION_SUMMARY_RECOVERY_MAX_OUTPUT_TOKENS
        : COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
    };
    let text = '';
    let stopReason: StopReason = null;
    let sawAssistant = false;
    for await (const ev of provider.stream(req, { signal, ...(boundaryTrace ? { boundaryTrace } : {}) })) {
      throwIfSummaryAborted(signal);
      if (ev.type === 'message_delta' && ev.stopReason !== null) {
        stopReason = ev.stopReason;
      }
      if (ev.type === 'assistant') {
        sawAssistant = true;
        if (ev.stopReason !== null) stopReason = ev.stopReason;
        const content = (ev.message as { content?: Array<{ type: string; text?: string }> })?.content;
        if (Array.isArray(content)) for (const b of content) if (b.type === 'text' && b.text) text += b.text;
      }
    }
    throwIfSummaryAborted(signal);
    if (stopReason === 'model_context_window_exceeded') {
      throw new ProviderSummaryError(
        'context_window_exceeded',
        `${PROMPT_TOO_LONG_MESSAGE}: compaction summary exceeded the model context window`,
      );
    }
    const summaryBlock = text.match(/<summary>([\s\S]*?)<\/summary>/);
    const completeSummary = summaryBlock?.[1]?.trim();
    if (stopReason === 'max_tokens') {
      if (!completeSummary) {
        throw new ProviderSummaryError(
          'max_tokens',
          'Compaction summary rejected: provider stopped at max_tokens.',
        );
      }
      // The provider may emit scratch text before the tag or a truncated tail
      // after it. Persist only the one complete summary block.
      return `<summary>${completeSummary}</summary>`;
    }
    if (!sawAssistant || stopReason === null || stopReason === 'tool_use' || stopReason === 'refusal') {
      throw new ProviderSummaryError(
        'incomplete',
        `Compaction summary rejected: incomplete provider response (stopReason=${String(stopReason)}).`,
      );
    }
    if (summaryBlock) {
      if (!completeSummary) {
        throw new ProviderSummaryError('empty', 'Compaction summary rejected: summary block is empty.');
      }
      // Normal completion must obey the same durable-content boundary as a
      // token-capped response: surrounding commentary is not conversation state.
      return `<summary>${completeSummary}</summary>`;
    }
    if (text.includes('<summary>') || text.includes('</summary>')) {
      throw new ProviderSummaryError('malformed_summary', 'Compaction summary rejected: summary block is incomplete.');
    }
    if (text.trim() === '') {
      throw new ProviderSummaryError('empty', 'Compaction summary rejected: provider returned no text.');
    }
    return text;
  };
}

export const COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS = 2048;
export const COMPACTION_SUMMARY_RECOVERY_MAX_OUTPUT_TOKENS = 4096;

function throwIfSummaryAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const cause = signal.reason instanceof Error ? signal.reason : undefined;
  throw new ProviderSummaryError(
    'aborted',
    typeof signal.reason === 'string' ? signal.reason : cause?.message ?? 'Compaction summary aborted.',
    cause ? { cause } : undefined,
  );
}

/** ★ Compaction V2 摘要器(管线版,带 scenario)——生产注入点直接喂给
 *  `compactionV2.summarize`。与 `makeProviderSummarize` 同源,差别仅在 scenario
 *  由**调用时**传入(管线据 CompactType 选 full / pre-message),core 仍不自调 LLM
 *  (走注入 provider)。 */
export function makeProviderCompactSummarize(
  provider: LLMProvider,
  model: string,
  customInstructions?: string,
  boundaryTrace?: ProviderCallOpts['boundaryTrace'],
): CompactSummarize {
  return (messages, scenario, signal, options) =>
    makeProviderSummarize(provider, model, scenario, customInstructions, boundaryTrace)(messages, signal, options);
}
