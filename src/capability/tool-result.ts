import type { CoreEvent } from '../events/types';
import { applyResultBudget } from '../context/tool-result-budget';
import { canonicalizeBoundaryContent } from './history-content';

/** Unwrap only the explicit transport envelope; retain native structured output.
 * Do not forward the CoreEvent itself (timestamps, tracing and host metadata).
 */
export function toolResultValue(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  if (Object.hasOwn(p, 'result')) return p.result;
  const { toolUseId, callId, ok, isError, ...value } = p;
  return value;
}

/** Explicit tool failure flags; ordinary output stays opaque. */
export function toolResultIsError(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return p.ok === false || p.isError === true;
}

/** tool_result.content 必须是 string 或 content-block 数组(Anthropic/OpenAI 皆然);
 *  工具 mapResult 的 payload 多为对象 → 这里规整成字符串,否则回灌时 provider 400
 *  (真 e2e 实测:对象 content → 次轮 model_error)。 */
function toolResultContent(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  // Image bytes are already carried as media blocks, not duplicated in text.
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const { imageBlocks, ...text } = payload as Record<string, unknown>;
    if (Object.keys(text).length === 1 && typeof text.message === 'string') return text.message;
    payload = text;
  }
  try {
    return JSON.stringify(payload) ?? '[tool result unavailable]';
  } catch {
    return String(payload);
  }
}

const CANONICAL_TOOL_RESULT_PART_TYPES = new Set(['text', 'image', 'audio', 'video', 'file', 'document']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Keep tool-result media as neutral content until the provider boundary.
 *
 * The old loop converted every object result to JSON before the adapter saw
 * it. That made a direct `{type:'image', data, mimeType}` result look like
 * ordinary text, so Anthropic/Responses/Gemini lost the media semantics on
 * the very next request. Only accept the bounded canonical content shapes;
 * arbitrary tool metadata continues through the legacy text path.
 */
function canonicalToolResultParts(payload: unknown): Array<Record<string, unknown>> | undefined {
  const normalized = canonicalizeBoundaryContent(payload);
  const values = Array.isArray(normalized) ? normalized : [normalized];
  if (values.length === 0) return undefined;
  const parts: Array<Record<string, unknown>> = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.type !== 'string' || !CANONICAL_TOOL_RESULT_PART_TYPES.has(value.type)) return undefined;
    parts.push(value);
  }
  return parts.length > 0 ? parts : undefined;
}

/** 多模态(011):从 tool.result payload 取 image content blocks(read_file 读图时挂在
 *  payload.imageBlocks)。无图返回 []。只挑形状合法的 `{type:'image',source}` 项,避免
 *  把脏数据塞进回灌内容触发 provider 400。 */
function imageBlocksFromPayload(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return [];
  const arr = (payload as Record<string, unknown>).imageBlocks;
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (b): b is Record<string, unknown> =>
      !!b &&
      typeof b === 'object' &&
      (b as Record<string, unknown>).type === 'image' &&
      typeof (b as Record<string, unknown>).source === 'object',
  );
}

export function toolResultsToContent(
  results: { toolUseId: string; toolName: string; result: CoreEvent; isError: boolean; newMessages?: CoreEvent[] }[],
  budgetFor?: (toolName: string) => number,
  persist?: (raw: string, meta: { toolUseId: string; toolName: string }) => string | undefined,
): unknown {
  const blocks: unknown[] = results.map((r) => {
    // 全局预算兜底(移植 agentic_os 03.B):单 tool 声明 maxResultSizeChars,这里统一裁。
    const max = budgetFor?.(r.toolName) ?? Infinity;
    // CORE-CTX-005:注入了 persist → 截断时全量落盘,marker 带回读路径;缺省不落盘(旧行为)。
    const opts = persist
      ? { persist: (raw: string) => persist(raw, { toolUseId: r.toolUseId, toolName: r.toolName }) }
      : undefined;
    const payload = toolResultValue(r.result.payload);
    const canonicalParts = canonicalToolResultParts(payload);
    const canonicalText = canonicalParts
      ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    const { output } = applyResultBudget(
      canonicalParts ? canonicalText ?? '' : toolResultContent(payload),
      max,
      opts,
    );
    // 多模态(011):工具(如 read_file 读图)在 payload 带 imageBlocks → tool_result.content
    //   组成 content 数组 [text, image…]。Anthropic 原样吃图;openai-compat 的
    //   toolResultToText 只取 text 块 → 优雅降级(丢图留文,不 400)。
    const images = imageBlocksFromPayload(payload);
    const media = canonicalParts?.filter((part) => part.type !== 'text') ?? images;
    const content = canonicalParts
      ? [
          ...(output ? [{ type: 'text', text: output }] : []),
          ...media,
          ...(output || media.length > 0 ? [] : [{ type: 'text', text: '[empty tool result]' }]),
        ]
      : images.length > 0
        ? [{ type: 'text', text: output }, ...images]
        : output;
    return {
      type: 'tool_result',
      tool_use_id: r.toolUseId,
      content,
      is_error: r.isError,
    };
  });
  return blocks;
}
