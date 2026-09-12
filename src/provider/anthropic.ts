/**
 * Anthropic Messages provider (C4) — 原生 fetch + SSE 流式。
 *
 * **不 import @anthropic-ai/sdk**（boundary lint 禁止，且会引入 package.json 依赖）：
 * 直接 POST `${baseUrl}/v1/messages` with `stream:true`，手解 SSE。
 *
 * 实现 LLMProvider.stream，把 Anthropic 的 SSE 事件规范化成 ProviderStreamEvent：
 *   message_start / content_block_start / content_block_delta / content_block_stop /
 *   message_delta / message_stop + 一条聚合后的 `assistant` 事件。
 * usage 用 C4 的 mergeUsage 累计。
 *
 * Boundary：只 import C4 契约（types.ts）。重试由上层 withRetry 包（retry.ts）。
 */

import { FORGEAX_USER_AGENT } from './user-agent';
import { canonicalizeBoundaryContent, isRecord as isHistoryRecord } from '../capability/history-content';
import { assertProviderWireSafe } from './wire-validator';
import {
  EMPTY_USAGE,
  mergeUsage,
  StreamIdleError,
  type LLMProvider,
  type ProviderCallOpts,
  type ProviderFactory,
  type ProviderFactoryOpts,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderToolDef,
  type StopReason,
  type SystemBlock,
  type Usage,
} from './types';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// ─── 请求体构造 ─────────────────────────────────────────────────────────────

/** system 块 → Anthropic system 数组；cacheScope 非空 → 打 cache_control（C7 边界）。 */
export function systemBlocksToAnthropic(blocks: SystemBlock[]): unknown[] {
  // 剔除内部 cache 分界哨兵(boundary):它不是模型内容,发出去会泄漏哨兵串。
  // 过滤后 cache marker 仍落在最后一个 scoped 块(末块或下一块无 scope),位置不变。
  return blocks.filter((b) => !b.boundary).map((block, i, arr) => {
    const entry: Record<string, unknown> = { type: 'text', text: block.text };
    // 在「最后一个带 cacheScope 的块」上落 cache marker：下一块无 scope 或已是末尾。
    const nextHasScope = i < arr.length - 1 && arr[i + 1].cacheScope != null;
    if (block.cacheScope != null && !nextHasScope) {
      entry.cache_control = { type: 'ephemeral' };
    }
    return entry;
  });
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const COMPOSITION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const;
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);
const SCHEMA_VALUE_KEYS = new Set([
  'additionalProperties',
  'contains',
  'contentSchema',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
  'else',
]);
const SCHEMA_ARRAY_KEYS = new Set(['items', 'prefixItems']);

function valueKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = valueKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferredType(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return undefined;
  }
}

function normalizeType(value: unknown, out: JsonObject): void {
  if (typeof value === 'string') {
    out.type = value;
    return;
  }
  if (!Array.isArray(value)) {
    delete out.type;
    return;
  }
  const types = value.filter((type): type is string => typeof type === 'string');
  const nonNullTypes = [...new Set(types.filter((type) => type !== 'null'))];
  if (nonNullTypes.length === 1) out.type = nonNullTypes[0];
  else delete out.type;
  if (types.includes('null')) out.nullable = true;
}

function normalizeSchemaChildren(out: JsonObject): void {
  for (const key of SCHEMA_MAP_KEYS) {
    const raw = out[key];
    if (!isJsonObject(raw)) continue;
    const normalized: JsonObject = {};
    for (const [name, child] of Object.entries(raw)) {
      normalized[name] = isJsonObject(child) ? normalizeAnthropicSchema(child) : child;
    }
    out[key] = normalized;
  }

  for (const key of SCHEMA_VALUE_KEYS) {
    const raw = out[key];
    if (isJsonObject(raw)) out[key] = normalizeAnthropicSchema(raw);
  }

  for (const key of SCHEMA_ARRAY_KEYS) {
    const raw = out[key];
    if (Array.isArray(raw)) {
      out[key] = raw.map((child) => isJsonObject(child) ? normalizeAnthropicSchema(child) : child);
    }
  }
}

function mergeSchemaVariant(target: JsonObject, variant: JsonObject): void {
  if (isJsonObject(variant.properties)) {
    const properties = isJsonObject(target.properties) ? { ...target.properties } : {};
    for (const [name, raw] of Object.entries(variant.properties)) {
      const previous = properties[name];
      if (isJsonObject(previous) && isJsonObject(raw)) {
        const merged = { ...previous };
        mergeSchemaVariant(merged, raw);
        properties[name] = merged;
      } else {
        properties[name] = raw;
      }
    }
    target.properties = properties;
  }

  const enums = [
    ...(Array.isArray(target.enum) ? target.enum : []),
    ...(Array.isArray(variant.enum) ? variant.enum : []),
  ];
  if (enums.length > 0) target.enum = uniqueValues(enums);

  const targetType = typeof target.type === 'string' ? target.type : undefined;
  const variantType = typeof variant.type === 'string' ? variant.type : undefined;
  if (!targetType && variantType) target.type = variantType;
  else if (targetType && variantType && targetType !== variantType) delete target.type;

  if (target.items === undefined && variant.items !== undefined) target.items = variant.items;
}

/**
 * LiteLLM's Anthropic translation accepts ordinary object schemas but rejects
 * composition keywords (`oneOf`/`anyOf`/`allOf`). Keep the rich schema inside
 * the tool dispatcher and flatten only the model-facing wire copy. Variants
 * are merged into one permissive object; the original schema remains the
 * execution-time validator.
 */
function normalizeAnthropicSchema(value: unknown, root = false): JsonObject {
  const source = isJsonObject(value) ? value : {};
  const out: JsonObject = { ...source };
  const variants = COMPOSITION_KEYS
    .flatMap((key) => Array.isArray(source[key]) ? source[key] : [])
    .filter(isJsonObject);
  for (const key of COMPOSITION_KEYS) delete out[key];

  normalizeType(out.type, out);
  if (Object.prototype.hasOwnProperty.call(out, 'const')) {
    const constant = out.const;
    delete out.const;
    out.enum = uniqueValues([
      ...(Array.isArray(out.enum) ? out.enum : []),
      constant,
    ]);
    if (typeof out.type !== 'string') {
      const type = inferredType(constant);
      if (type) out.type = type;
    }
  }

  normalizeSchemaChildren(out);
  for (const variant of variants) mergeSchemaVariant(out, normalizeAnthropicSchema(variant));
  normalizeSchemaChildren(out);
  if (root && typeof out.type !== 'string') out.type = 'object';
  return out;
}

export function toolDefsToAnthropic(
  tools: ProviderToolDef[],
  enablePromptCaching = false,
): unknown[] | undefined {
  if (!tools.length) return undefined;
  const mapped = tools.map((t) => {
    // Anthropic (and LiteLLM's Anthropic translator) requires every custom
    // tool schema to declare a top-level JSON-Schema type. Host/MCP tools may
    // legally arrive with an omitted type or an empty schema; normalize that
    // at the wire boundary instead of letting one malformed tool reject the
    // entire turn with `custom.input_schema.type: Field required`.
    const inputSchema = normalizeAnthropicSchema(t.inputSchema, true);
    return {
      name: t.name,
      description: t.description,
      input_schema: inputSchema,
    };
  });
  if (enablePromptCaching) {
    (mapped[mapped.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }
  return mapped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const ANTHROPIC_MEDIA_UNAVAILABLE = '[content unavailable for Anthropic]';
const ANTHROPIC_EMPTY_CONTENT = '[empty content omitted]';

function anthropicContentBlock(raw: unknown): unknown | undefined {
  if (typeof raw === 'string') return raw.length > 0 ? { type: 'text', text: raw } : undefined;
  if (!isHistoryRecord(raw)) return undefined;

  switch (raw.type) {
    case 'text':
      return typeof raw.text === 'string' && raw.text.length > 0 ? { type: 'text', text: raw.text } : undefined;
    case 'image': {
      if (isRecord(raw.source)) return raw;
      if (typeof raw.data === 'string' && typeof raw.mimeType === 'string') {
        return { type: 'image', source: { type: 'base64', media_type: raw.mimeType, data: raw.data } };
      }
      return { type: 'text', text: ANTHROPIC_MEDIA_UNAVAILABLE };
    }
    case 'document': {
      if (isRecord(raw.source)) return raw;
      if (typeof raw.data === 'string' && typeof raw.mimeType === 'string') {
        return { type: 'document', source: { type: 'base64', media_type: raw.mimeType, data: raw.data } };
      }
      return { type: 'text', text: ANTHROPIC_MEDIA_UNAVAILABLE };
    }
    case 'file':
      if (typeof raw.data === 'string' && typeof raw.mimeType === 'string' && raw.mimeType === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: raw.mimeType, data: raw.data } };
      }
      return { type: 'text', text: ANTHROPIC_MEDIA_UNAVAILABLE };
    case 'audio':
    case 'video':
      return { type: 'text', text: ANTHROPIC_MEDIA_UNAVAILABLE };
    case 'tool_use': {
      const out: Record<string, unknown> = {
        type: 'tool_use',
        id: typeof raw.id === 'string' ? raw.id : 'unnamed-call',
        name: typeof raw.name === 'string' && raw.name ? raw.name : 'unnamed_tool',
        // Opaque by contract: no recursive traversal of input.
        input: raw.input ?? {},
      };
      if (Object.prototype.hasOwnProperty.call(raw, 'content')) {
        const nested = anthropicContent(raw.content);
        if (nested.length > 0) out.content = nested;
      }
      return out;
    }
    case 'tool_result': {
      const nested = anthropicContent(raw.content);
      const out: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '',
        content: nested.length > 0 ? nested : [{ type: 'text', text: '[empty tool result]' }],
      };
      if (raw.is_error === true) out.is_error = true;
      // Anthropic does not need the Gemini-only name field.
      return out;
    }
    case 'thinking':
      return typeof raw.thinking === 'string' ? raw : undefined;
    case 'redacted_thinking':
      return typeof raw.data === 'string' ? raw : undefined;
    case 'server_tool_use':
      return raw;
    default:
      // Current-turn provider-shaped blocks are kept only when they are already
      // Anthropic wire blocks; anything else becomes an explicit safe marker.
      if (raw.type === 'input_text' && typeof raw.text === 'string') return { type: 'text', text: raw.text };
      return { type: 'text', text: ANTHROPIC_MEDIA_UNAVAILABLE };
  }
}

function anthropicContent(content: unknown): unknown[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) {
    const block = anthropicContentBlock(content);
    return block === undefined ? [] : [block];
  }
  return content.map(anthropicContentBlock).filter((block): block is unknown => block !== undefined);
}

function mapContentToAnthropic(content: unknown): unknown {
  const normalized = canonicalizeBoundaryContent(content);
  if (typeof normalized === 'string') return normalized.length > 0 ? normalized : [{ type: 'text', text: ANTHROPIC_EMPTY_CONTENT }];
  const blocks = anthropicContent(normalized);
  return blocks.length > 0 ? blocks : [{ type: 'text', text: ANTHROPIC_EMPTY_CONTENT }];
}

/**
 * Anthropic rejects zero-length text blocks anywhere in message content. Remove only
 * `{type:'text', text:''}` while preserving whitespace text, tool_use/tool_result blocks,
 * opaque tool input, and every other wire value.
 */
function filterEmptyTextBlocks(content: unknown): unknown {
  if (Array.isArray(content)) {
    let changed = false;
    const filtered: unknown[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && block.text === '') {
        changed = true;
        continue;
      }
      const next = filterEmptyTextBlocks(block);
      if (next !== block) changed = true;
      filtered.push(next);
    }
    return changed ? filtered : content;
  }
  if (!isRecord(content) || content.type === 'image') return content;

  // These are the same content-bearing envelopes accepted by history normalization.
  // In particular, tool_use.input is opaque and must never be traversed or rewritten.
  const contentKeys = content.type === 'tool_use' ? ['content'] : ['content', 'result', 'envelope'];
  let filtered: Record<string, unknown> | undefined;
  for (const key of contentKeys) {
    if (!Object.prototype.hasOwnProperty.call(content, key)) continue;
    const value = content[key];
    const next = filterEmptyTextBlocks(value);
    if (next !== value) {
      filtered ??= { ...content };
      filtered[key] = next;
    }
  }
  return filtered ?? content;
}

export function messagesToAnthropic(messages: ProviderMessage[]): unknown[] {
  // 正常的 forgeax-core facade 已在 mapHistory() 读时完成转换；这里再做一次边界兜底，
  // 保护直接调用 provider 的路径和旧的 ProviderMessage seed。失败项只落无路径占位文本，
  // 绝不把 host-neutral image_file 形状或敏感路径透传给 Anthropic。
  return messages.map((m) => {
    const normalized = mapContentToAnthropic(m.content);
    const filtered = filterEmptyTextBlocks(normalized);
    return {
      role: m.role,
      content: Array.isArray(filtered) && filtered.length === 0 ? [{ type: 'text', text: ANTHROPIC_EMPTY_CONTENT }] : filtered,
    };
  });
}

/**
 * fire-and-forget fork：cache 标记打倒数第二条 user content 的最后一块
 * （skipCacheWrite 反转语义 —— 默认打最后一条；skipCacheWrite 时退一条，
 * 让最新一条的 dynamic 字节落在 cache prefix 外）。
 */
export function annotateMessageCache(messages: unknown[], skipCacheWrite?: boolean): void {
  const userIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: string };
    if (m?.role === 'user') userIdxs.push(i);
  }
  if (userIdxs.length === 0) return;
  const targetUserIdx = skipCacheWrite
    ? userIdxs[userIdxs.length - 2]
    : userIdxs[userIdxs.length - 1];
  if (targetUserIdx === undefined) return;

  const msg = messages[targetUserIdx] as { content?: unknown };
  const content = msg.content;
  if (typeof content === 'string') {
    if (content.length === 0) return;
    msg.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (!Array.isArray(content) || content.length === 0) return;
  const last = content[content.length - 1] as Record<string, unknown> | undefined;
  if (last && typeof last === 'object') {
    content[content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
  }
}

/**
 * Opus 4.7+ 只支持 thinking.type=adaptive（拒绝 enabled + 采样参数）；其余模型用
 * enabled+budget_tokens 封顶思考,避免 adaptive 无上限导致单轮思考失控。
 * 判定与 orchestrator 栈（llm/anthropic.ts 的 isAdaptiveOnlyModel）保持一致。
 */
function isAdaptiveOnlyModel(model: string): boolean {
  const m = model.match(/claude-opus-(\d+)-(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 4 || (major === 4 && minor >= 7);
}

/**
 * os1 parity (agentic_os `applyThinkingPolicy` + `assistantThinkingConsistent`).
 *
 * Extended thinking requires that every assistant turn carrying a `tool_use`
 * block begin with the original `thinking` (or `redacted_thinking`) block, or
 * the request fails `400 invalid_request: ...content.0.type expected 'thinking'`.
 * Models like glm-5.2/zaohua-pro stream thinking but return it WITHOUT a
 * (replayable) signature, so those blocks get dropped from history — once the
 * conversation has a tool_use turn lacking a leading thinking block, keeping
 * thinking enabled just makes the model re-think from scratch every turn (no
 * cross-turn continuity, pure latency; observed as os2 being ~2x slower than
 * os1 with no quality gain).
 *
 * Returns false if ANY assistant turn with a tool_use block does not start with
 * a thinking / redacted_thinking block — the caller then degrades that request
 * to no-thinking, exactly like os1.
 */
function assistantThinkingConsistent(messages: any[]): boolean {
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const hasToolUse = m.content.some((b: any) => b?.type === 'tool_use');
    if (!hasToolUse) continue;
    const first = m.content[0];
    if (!first || (first.type !== 'thinking' && first.type !== 'redacted_thinking')) return false;
  }
  return true;
}

/**
 * Drop `thinking` / `redacted_thinking` blocks from wire messages (os1
 * `stripThinkingBlocks`). Used whenever the outgoing request will NOT enable
 * thinking — Anthropic/gateway rejects input thinking blocks when the thinking
 * channel is off. Reassigns `content` (never mutates the caller's block array)
 * and never empties a message.
 */
function stripThinkingBlocks(messages: any[]): void {
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    const filtered = m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
    if (filtered.length > 0 && filtered.length !== m.content.length) m.content = filtered;
  }
}

export function buildRequestBody(req: ProviderRequest): Record<string, unknown> {
  const anthropicMessages = messagesToAnthropic(req.messages);
  const body: Record<string, unknown> = {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: true,
  };

  const systemArr = systemBlocksToAnthropic(req.system);
  if (systemArr.length) body.system = systemArr;

  if (req.enablePromptCaching !== false) {
    annotateMessageCache(anthropicMessages, req.skipCacheWrite);
  }

  const tools = toolDefsToAnthropic(req.tools, req.enablePromptCaching !== false);
  if (tools) body.tools = tools;

  // Thinking channel (os1 parity). Only enable thinking when the model wants it
  // AND history is thinking-consistent; otherwise degrade this request to
  // no-thinking + strip orphan thinking blocks (mirrors agentic_os
  // applyThinkingPolicy). This is what makes os1 "think early, off during the
  // tool loop" for glm-5.2/zaohua-pro (whose thinking can't be replayed).
  if (req.thinking && req.thinking.type !== 'disabled' && assistantThinkingConsistent(anthropicMessages)) {
    // Opus 4.7+ 保留 adaptive（模型自适应,无预算上限,且 4.7+ 拒绝 enabled）；其余模型
    // （含 glm-5.2/zaohua-pro）即使请求 adaptive 也降级为封顶 enabled —— adaptive 无 budget
    // 上限会让单轮思考失控（实测 glm-5.2 单轮 47K thinking token / 8.7min,近乎零产出）。
    if (req.thinking.type === 'adaptive' && isAdaptiveOnlyModel(req.model)) {
      // display:'summarized' 才会流式吐 thinking 增量(UI 可见)；缺省思考但不显示。
      body.thinking = req.thinking.display
        ? { type: 'adaptive', display: req.thinking.display }
        : { type: 'adaptive' };
    } else {
      const budget = req.thinking.budgetTokens ?? 8192;
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // max_tokens 必须 > budget_tokens,否则 Anthropic 400。
      if ((body.max_tokens as number) <= budget) body.max_tokens = budget + 4096;
    }
    // thinking 开启时不发 temperature（API 要求 temp=1，省略即可）。
  } else {
    // thinking off — disabled, not requested, or degraded for consistency. Strip
    // any orphan thinking blocks so we never send thinking blocks with thinking
    // off (gateway/Anthropic rejects that), then pass temperature.
    stripThinkingBlocks(anthropicMessages);
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
  }

  assertProviderWireSafe(body, 'anthropic');

  return body;
}

// ─── SSE 解析 ───────────────────────────────────────────────────────────────

/** SSE 读空闲超时(ms):上游连续这么久不吐**任何字节**(含 ping)即判定卡死,abort 抛错。
 *  健康但慢的流靠 ping 持续重置计时器,不会误杀;真正 stall(代理 hold 住连接不发数据)
 *  才触发 —— 修「整轮无响应永久挂死」的根因。请求超时只覆盖 fetch() 初次握手,不覆盖流式 body。
 *  **全后端通用**:SSE 系(anthropic/vertex/openai-compat/gemini/openai-response 经共享 parseSSE)+
 *  Bedrock(经 decodeBedrockEventStream,import 本函数;正是这条经代理转 Bedrock 的链路催生本修复)。
 *
 *  数值对齐 claude-code(v2.1.175):cc `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 默认 5min、byte 看门狗
 *  clamp 到 [10s, 30min]。此前 forgeax 默认 90s 偏激进 —— 经代理转 Bedrock 的链路常不透传
 *  Anthropic 的 SSE `ping`、且做缓冲,一次「长思考 + 慢代理」就能凑够 90s 零字节误杀。改默认 300s。
 *  0/负 = 关闭(回退旧无超时行为);非 0 的 env 值 clamp 到 [10s, 30min]。
 *  env `FORGEAX_PROVIDER_IDLE_MS` 可调。该看门狗默认**开**。命中后由 stream-retry 有界重发(对齐 cc)。 */
const STREAM_IDLE_DEFAULT_MS = 300_000; // cc UL8=max(env,300000):整流空闲默认 5min
const STREAM_IDLE_MIN_MS = 10_000; //     cc clamp 下界(Zm5=1e4)
const STREAM_IDLE_MAX_MS = 1_800_000; //  cc clamp 上界(Gm5=1.8e6=30min)
export function providerStreamIdleMs(): number {
  const v = Number(process.env.FORGEAX_PROVIDER_IDLE_MS);
  if (!Number.isFinite(v) || v < 0) return STREAM_IDLE_DEFAULT_MS;
  if (v === 0) return 0; // 显式关闭(escape hatch)
  return Math.min(Math.max(v, STREAM_IDLE_MIN_MS), STREAM_IDLE_MAX_MS);
}

/** `reader.read()` 加空闲超时与取消:任一命中都立即 settle，并 best-effort cancel 底层 reader。
 *  任何到达的字节(含 ping)都会让下一次调用重置计时器。SSE 系经 parseSSE、Bedrock 经
 *  decodeBedrockEventStream 共用本函数(SSOT:阻塞 read 包裹只此一份)。 */
export async function readWithIdleTimeout(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> },
  idleMs: number,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal?.aborted) throw abortError(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    if (idleMs > 0) timer = setTimeout(() => reject(new StreamIdleError(idleMs)), idleMs);
    if (signal) {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([reader.read(), interrupted]);
  } catch (e) {
    try {
      await reader.cancel(e);
    } catch {
      /* ignore cleanup failure; preserve abort/idle error */
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'aborted');
  error.name = 'AbortError';
  return error;
}

/** 解析 SSE 字节流为 { event?, data } 帧。CRLF 规范化 + `\n\n` 分块。 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  idleMs: number = providerStreamIdleMs(),
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleMs, signal);
      if (done) break;
      buffer += decoder
        .decode(value, { stream: true })
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── 流事件规范化 ───────────────────────────────────────────────────────────

type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface CurrentBlock {
  blockType: 'text' | 'thinking' | 'tool_use' | 'server_tool_use';
  text?: string;
  textSanitizer?: AssistantTextSanitizer;
  thinking?: string;
  signature?: string;
  data?: string;
  toolId?: string;
  toolName?: string;
  toolArgs?: string;
}

/**
 * Remove the provider's bare phase markers from assistant text without treating
 * ordinary HTML as markup to discard.
 *
 * The zaohua personal-9 regression delivered `<phase>...</phase>` in text
 * blocks. Anthropic may split a marker at any SSE boundary, so this scanner
 * keeps an incomplete `<...` candidate between calls. Only `phase` and a
 * numeric suffix (`phase2`, `phase10`, ...) are control markers; names such as
 * `phase_name`, `phaser`, and ordinary HTML remain visible.
 */
export interface AssistantTextSanitizer {
  push(text: string): string;
  finish(): string;
}

const PHASE_OPEN_RE = /^<\s*phase\d*\s*>$/i;
const PHASE_CLOSE_RE = /^<\s*\/\s*phase\d*\s*>$/i;

function isPhaseOpenTag(token: string): boolean {
  return PHASE_OPEN_RE.test(token);
}

function isPhaseCloseTag(token: string): boolean {
  return PHASE_CLOSE_RE.test(token);
}

/** Create a stateful sanitizer for one assistant text block. */
export function createAssistantTextSanitizer(): AssistantTextSanitizer {
  let mode: 'visible' | 'phase' = 'visible';
  let pending = '';

  const scan = (text: string, final: boolean): string => {
    let source = pending + text;
    pending = '';
    let out = '';

    while (source.length > 0) {
      if (mode === 'phase') {
        // Everything inside a phase marker is provider control text. Keep only
        // a possible partial closing tag so a split `</phase>` is recognized.
        const lt = source.indexOf('<');
        if (lt < 0) return out;
        source = source.slice(lt);
        const gt = source.indexOf('>');
        if (gt < 0) {
          if (!final) pending = source;
          return out;
        }
        const token = source.slice(0, gt + 1);
        source = source.slice(gt + 1);
        if (isPhaseCloseTag(token)) mode = 'visible';
        continue;
      }

      const lt = source.indexOf('<');
      if (lt < 0) {
        out += source;
        return out;
      }
      out += source.slice(0, lt);
      source = source.slice(lt);
      const gt = source.indexOf('>');
      if (gt < 0) {
        if (!final) pending = source;
        else out += source;
        return out;
      }
      const token = source.slice(0, gt + 1);
      source = source.slice(gt + 1);
      if (isPhaseOpenTag(token)) {
        mode = 'phase';
      } else {
        // Not a control marker: preserve the complete token verbatim. This is
        // what keeps `<phase_name>` and ordinary HTML unchanged.
        out += token;
      }
    }
    return out;
  };

  return {
    push(text: string): string {
      return scan(text, false);
    },
    finish(): string {
      // A visible, incomplete token is ordinary text until proven otherwise;
      // an incomplete token while suppressing a phase body is discarded.
      return scan('', true);
    },
  };
}

/** One-shot helper used by callers/tests that have an already assembled block. */
export function sanitizeAssistantText(text: string): string {
  const sanitizer = createAssistantTextSanitizer();
  return sanitizer.push(text) + sanitizer.finish();
}

function rawUsageToPartial(raw: Record<string, unknown> | undefined): Partial<Usage> {
  if (!raw) return {};
  const num = (k: string): number | undefined =>
    typeof raw[k] === 'number' ? (raw[k] as number) : undefined;
  const out: Partial<Usage> = {};
  const input = num('input_tokens');
  if (input !== undefined) out.inputTokens = input;
  const output = num('output_tokens');
  if (output !== undefined) out.outputTokens = output;
  const cacheRead = num('cache_read_input_tokens');
  if (cacheRead !== undefined) out.cacheReadInputTokens = cacheRead;
  const cacheCreate = num('cache_creation_input_tokens');
  if (cacheCreate !== undefined) out.cacheCreationInputTokens = cacheCreate;
  const cc = raw['cache_creation'];
  if (cc && typeof cc === 'object') {
    const ccr = cc as Record<string, unknown>;
    out.cacheCreation = {
      ephemeral1h: typeof ccr.ephemeral_1h_input_tokens === 'number' ? ccr.ephemeral_1h_input_tokens : undefined,
      ephemeral5m: typeof ccr.ephemeral_5m_input_tokens === 'number' ? ccr.ephemeral_5m_input_tokens : undefined,
    };
  }
  return out;
}

function normalizeStopReason(raw: unknown): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'refusal':
    case 'model_context_window_exceeded':
      return raw;
    default:
      return null;
  }
}

/**
 * 把 Anthropic SSE 帧序列规范化成 ProviderStreamEvent 序列（纯逻辑，便于测试）。
 * 不打网络：传入 parseSSE 出的 {event,data} 帧即可。
 */
export async function* normalizeAnthropicStream(
  frames: AsyncIterable<{ event?: string; data: string }>,
  opts?: { requestId?: string; httpStatus?: number; signal?: AbortSignal },
): AsyncGenerator<ProviderStreamEvent> {
  let usage: Usage = { ...EMPTY_USAGE, reported: {} };
  let stopReason: StopReason = null;
  let current: CurrentBlock | null = null;
  const blocks: AssistantBlock[] = [];
  const startedAt = Date.now();
  let firstTokenAt: number | undefined;

  for await (const { event, data } of frames) {
    if (opts?.signal?.aborted) break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (event ?? (parsed.type as string | undefined)) as string | undefined;

    switch (type) {
      case 'message_start': {
        const msg = parsed.message as { usage?: Record<string, unknown> } | undefined;
        const partial = rawUsageToPartial(msg?.usage);
        usage = { ...mergeUsage(usage, partial), reported: { ...usage.reported, ...partial } };
        yield { type: 'message_start', usage: partial };
        break;
      }

      case 'content_block_start': {
        const index = (parsed.index as number) ?? 0;
        const block = parsed.content_block as Record<string, unknown> | undefined;
        const bt = block?.type;
        if (bt === 'tool_use' || bt === 'server_tool_use') {
          current = {
            blockType: bt === 'server_tool_use' ? 'server_tool_use' : 'tool_use',
            toolId: typeof block?.id === 'string' ? block.id : undefined,
            toolName: typeof block?.name === 'string' ? block.name : undefined,
            toolArgs: '',
          };
          yield { type: 'content_block_start', index, blockType: current.blockType };
        } else if (bt === 'thinking') {
          current = {
            blockType: 'thinking',
            thinking: typeof block?.thinking === 'string' ? block.thinking : '',
            signature: typeof block?.signature === 'string' ? block.signature : undefined,
          };
          yield { type: 'content_block_start', index, blockType: 'thinking' };
        } else if (bt === 'redacted_thinking') {
          current = {
            blockType: 'thinking',
            data: typeof block?.data === 'string' ? block.data : '',
          };
          yield { type: 'content_block_start', index, blockType: 'thinking' };
        } else {
          const textSanitizer = createAssistantTextSanitizer();
          const initialText = typeof block?.text === 'string' ? textSanitizer.push(block.text) : '';
          current = { blockType: 'text', text: initialText, textSanitizer };
          yield { type: 'content_block_start', index, blockType: 'text' };
        }
        break;
      }

      case 'content_block_delta': {
        const index = (parsed.index as number) ?? 0;
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (!delta) break;
        if (firstTokenAt === undefined) firstTokenAt = Date.now();
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (current?.blockType === 'text') {
            const cleanText = current.textSanitizer?.push(delta.text) ?? delta.text;
            current.text = (current.text ?? '') + cleanText;
            // The kernel facade maps this provider delta directly to the
            // assistant `message.delta` stream consumed by the UI.
            delta.text = cleanText;
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          if (current?.blockType === 'thinking')
            current.thinking = (current.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          if (current?.blockType === 'thinking') current.signature = delta.signature;
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (current && (current.blockType === 'tool_use' || current.blockType === 'server_tool_use'))
            current.toolArgs = (current.toolArgs ?? '') + delta.partial_json;
        }
        yield { type: 'content_block_delta', index, delta };
        break;
      }

      case 'content_block_stop': {
        const index = (parsed.index as number) ?? 0;
        let finished: AssistantBlock | undefined;
        if (current) {
          if (current.blockType === 'tool_use' || current.blockType === 'server_tool_use') {
            let input: Record<string, unknown> = {};
            try {
              input = current.toolArgs ? (JSON.parse(current.toolArgs) as Record<string, unknown>) : {};
            } catch {
              input = {};
            }
            finished = {
              type: 'tool_use',
              id: current.toolId ?? '_tool',
              name: current.toolName ?? 'unnamed_tool',
              input,
            };
          } else if (current.blockType === 'thinking') {
            if (current.data !== undefined) {
              finished = { type: 'redacted_thinking', data: current.data };
            } else {
              finished = {
                type: 'thinking',
                thinking: current.thinking ?? '',
                ...(current.signature ? { signature: current.signature } : {}),
              };
            }
          } else if (current.blockType === 'text') {
            const trailing = current.textSanitizer?.finish() ?? '';
            if (trailing) {
              // A visible incomplete token is held until the block boundary so
              // it can be classified with the next delta. Flush it as a final
              // live delta before the stop event, keeping streamed and
              // aggregated assistant bytes identical.
              current.text = (current.text ?? '') + trailing;
              yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: trailing } };
            }
            if (current.text) finished = { type: 'text', text: current.text };
          }
        }
        if (finished) blocks.push(finished);
        yield { type: 'content_block_stop', index, block: finished };
        current = null;
        break;
      }

      case 'message_delta': {
        const partial = rawUsageToPartial(parsed.usage as Record<string, unknown> | undefined);
        usage = { ...mergeUsage(usage, partial), reported: { ...usage.reported, ...partial } };
        const dr = (parsed.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
        stopReason = normalizeStopReason(dr);
        yield { type: 'message_delta', usage: partial, stopReason };
        break;
      }

      case 'message_stop': {
        yield { type: 'message_stop' };
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: blocks },
          usage,
          stopReason,
          ...(opts?.requestId ? { requestId: opts.requestId } : {}),
          ...(opts?.httpStatus !== undefined ? { httpStatus: opts.httpStatus } : {}),
        };
        break;
      }

      default:
        break;
    }
  }

  // 防御：若上游未发 message_stop（连接断），仍吐已聚合的 assistant。
  void startedAt;
  void firstTokenAt;
}

// ─── HTTP 错误（带 status / retryAfterMs，供 retry.ts 消费）────────────────

function throwHttpError(res: Response, text: string, model: string): never {
  const err = new Error(`anthropic API error ${res.status}: ${text.slice(0, 500)}`) as Error & {
    status: number;
    model: string;
    responseText: string;
    retryAfterMs?: number;
  };
  err.status = res.status;
  err.model = model;
  err.responseText = text;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) err.retryAfterMs = seconds * 1000;
  }
  throw err;
}

// ─── Provider 工厂 ──────────────────────────────────────────────────────────

export const createAnthropicProvider: ProviderFactory = (
  opts: ProviderFactoryOpts,
): LLMProvider => {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${base}/v1/messages`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': FORGEAX_USER_AGENT,
    'anthropic-version': ANTHROPIC_VERSION,
    'x-api-key': opts.apiKey,
    ...(opts.headers ?? {}),
  };

  return {
    api: 'anthropic-messages',
    endpointOrigin: new URL(url).origin,
    async *stream(
      req: ProviderRequest,
      callOpts: ProviderCallOpts,
    ): AsyncIterable<ProviderStreamEvent> {
      const body = buildRequestBody(req);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: callOpts.signal,
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : '';
        throwHttpError(res, text, req.model);
      }
      const requestId = res.headers.get('request-id') ?? res.headers.get('x-request-id') ?? undefined;
      yield* normalizeAnthropicStream(parseSSE(res.body, providerStreamIdleMs(), callOpts.signal), {
        requestId,
        httpStatus: res.status,
        signal: callOpts.signal,
      });
    },
  };
};
