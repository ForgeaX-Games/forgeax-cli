/** LLM 错误分类与友好化消息
 *
 * 设计原则：默认重试 + 黑名单
 * - 只有明确的客户端错误（4xx 除 429）和用户取消才不重试
 * - 其他所有错误（网络、服务端、未知）都重试，直到耗尽次数
 * - 用户可通过 maxRetries: 0 关闭重试
 */

// ── 错误类型定义 ─────────────────────────────────────────

/** 终端错误（不重试） */
export class TerminalLLMError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "TerminalLLMError";
  }
}

/** 可重试错误 */
export class RetryableLLMError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryDelayMs?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "RetryableLLMError";
  }
}

/** 网络错误（可重试子类） */
export class NetworkError extends RetryableLLMError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, undefined, cause);
    this.name = "NetworkError";
  }
}

// ── 常量定义 ─────────────────────────────────────────────

/** 终端 HTTP 状态码（客户端错误，不重试）
 *  注意：429 不在此列，429 是可重试的限流错误
 */
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

// ── 错误分类 ─────────────────────────────────────────────

export type ClassifiedError =
  | { kind: "aborted"; error: TerminalLLMError }
  | { kind: "terminal"; error: TerminalLLMError }
  | { kind: "retryable"; error: RetryableLLMError };

/** 从错误对象提取 HTTP 状态码 */
function getStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return undefined;
}

/** 从错误对象提取网络错误码 */
function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "string") return e.code;
  // 遍历 cause 链
  if (e.cause) return getErrorCode(e.cause);
  return undefined;
}

/** 从错误对象提取消息 */
function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  if (typeof err === "string") return err;
  try {
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** 从错误对象提取 retryDelayMs（如果 API 返回了 Retry-After） */
function getRetryDelay(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.retryAfterMs === "number") return e.retryAfterMs;
  if (typeof e.retryDelayMs === "number") return e.retryDelayMs;
  return undefined;
}

type LLMErrorSource = {
  provider?: string;
  model?: string;
  keySection?: string;
};

export function annotateLLMError(err: unknown, source: LLMErrorSource): void {
  if (typeof err !== "object" || err === null) return;
  const target = err as Record<string, unknown>;
  if (source.provider && typeof target.provider !== "string") {
    target.provider = source.provider;
  }
  if (source.model && typeof target.model !== "string") {
    target.model = source.model;
  }
  if (source.keySection && typeof target.keySection !== "string") {
    target.keySection = source.keySection;
  }
}

/**
 * 判断是否为用户主动取消
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError";
}

type StructuredApiError = {
  code?: number;
  status?: string;
  message?: string;
  details?: unknown[];
};

function parseStructuredApiError(raw: string): StructuredApiError | null {
  const tryParse = (input: string): StructuredApiError | null => {
    try {
      const parsed = JSON.parse(input) as { error?: StructuredApiError };
      if (parsed?.error && typeof parsed.error === "object") {
        return parsed.error;
      }
    } catch {
      // ignore non-JSON error strings
    }
    return null;
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    return tryParse(raw.slice(jsonStart));
  }

  return null;
}

function formatFieldViolation(
  violation: unknown,
): { text: string; isEnumIssue: boolean } | null {
  if (typeof violation !== "object" || violation === null) return null;

  const data = violation as Record<string, unknown>;
  const field = typeof data.field === "string" ? data.field : undefined;
  const description = typeof data.description === "string" ? data.description : undefined;
  if (!field && !description) return null;

  const isEnumIssue =
    (field?.includes(".enum[") ?? false) ||
    (description?.includes(".enum[") ?? false);
  const text = field && description ? `${field}: ${description}` : (description ?? field)!;
  return { text, isEnumIssue };
}

function formatStructuredBadRequest(raw: string): string | null {
  const error = parseStructuredApiError(raw);
  if (!error) return null;

  const violations: { text: string; isEnumIssue: boolean }[] = [];
  for (const detail of error.details ?? []) {
    if (typeof detail !== "object" || detail === null) continue;
    const record = detail as Record<string, unknown>;
    const fieldViolations = record.fieldViolations;
    if (!Array.isArray(fieldViolations)) continue;

    for (const violation of fieldViolations) {
      const formatted = formatFieldViolation(violation);
      if (formatted) violations.push(formatted);
    }
  }

  if (violations.length === 0) {
    const message = error.message?.trim();
    return message ? `API 请求参数错误: ${message}` : null;
  }

  const header = error.status
    ? `API 请求参数错误 (${error.status})`
    : "API 请求参数错误";
  const lines = violations.map((violation) => `- ${violation.text}`);

  if (violations.some((violation) => violation.isEnumIssue)) {
    lines.push(
      "- 提示: Gemini function schema 对 enum 很严格，非字符串 enum 常会被拒绝；可改成字符串 enum，或在适配层降级掉 enum。",
    );
  }

  return `${header}:\n${lines.join("\n")}`;
}

function getStringField(err: unknown, field: "provider" | "model" | "keySection"): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as Record<string, unknown>)[field];
  return typeof value === "string" && value ? value : undefined;
}

function appendErrorSource(message: string, err: unknown): string {
  const model = getStringField(err, "model");
  const keySection = getStringField(err, "keySection");
  const provider = getStringField(err, "provider");
  const parts = [
    model ? `model=${model}` : undefined,
    keySection ? `key=${keySection}` : undefined,
    provider ? `provider=${provider}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${message} (${parts.join(", ")})` : message;
}

/**
 * 分类 LLM 调用错误
 *
 * 设计：默认重试 + 黑名单
 * - aborted: 用户主动取消，不属于模型失败
 * - terminal: 明确不应重试（4xx 客户端错误）
 * - retryable: 其他所有错误（网络、服务端、未知）
 */
export function classifyLLMError(err: unknown): ClassifiedError {
  if (err instanceof TerminalLLMError) {
    if (err.code === "ABORT") return { kind: "aborted", error: err };
    return { kind: "terminal", error: err };
  }
  if (err instanceof RetryableLLMError) {
    return { kind: "retryable", error: err };
  }

  const message = getMessage(err);
  const status = getStatus(err);
  const code = getErrorCode(err);
  const retryDelay = getRetryDelay(err);
  const originalError = err instanceof Error ? err : new Error(message);

  // ─── 黑名单：明确不重试 ───────────────────────────────

  // 1. 用户主动取消
  if (isAbortError(err)) {
    return {
      kind: "aborted",
      error: new TerminalLLMError("请求已取消", "ABORT", originalError),
    };
  }

  // 2. 4xx 客户端错误（除 429 限流）
  if (status !== undefined && TERMINAL_STATUSES.has(status)) {
    return {
      kind: "terminal",
      error: new TerminalLLMError(
        appendErrorSource(formatStatusError(status, message), err),
        `HTTP_${status}`,
        originalError,
      ),
    };
  }

  // ─── 其他所有错误：默认重试 ─────────────────────────────

  // 有网络错误码
  if (code) {
    return {
      kind: "retryable",
      error: new NetworkError(
        appendErrorSource(formatNetworkError(code, message), err),
        code,
        originalError,
      ),
    };
  }

  // 有 HTTP 状态码（429、5xx 等）
  if (status !== undefined) {
    return {
      kind: "retryable",
      error: new RetryableLLMError(
        appendErrorSource(formatStatusError(status, message), err),
        `HTTP_${status}`,
        retryDelay,
        originalError,
      ),
    };
  }

  // 未知错误也默认重试
  return {
    kind: "retryable",
    error: new RetryableLLMError(
      appendErrorSource(formatUnknownError(message), err),
      "UNKNOWN",
      retryDelay,
      originalError,
    ),
  };
}

// ── 友好化错误消息 ───────────────────────────────────────

/** 格式化网络错误消息 */
function formatNetworkError(code: string, original: string): string {
  switch (code) {
    case "ECONNREFUSED":
      return `无法连接到 API 服务器`;
    case "ECONNRESET":
      return `与 API 服务器的连接被重置`;
    case "ETIMEDOUT":
      return `连接 API 服务器超时`;
    case "ENOTFOUND":
      return `无法解析 API 服务器地址`;
    case "EAI_AGAIN":
      return `DNS 解析临时失败`;
    case "EPIPE":
      return `与 API 服务器的连接意外断开`;
    case "UND_ERR_SOCKET":
      return `与 API 服务器的连接异常中断`;
    case "EPROTO":
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC":
      return `SSL/TLS 连接错误`;
    default:
      if (/fetch failed/i.test(original)) {
        return `网络连接失败`;
      }
      return `网络错误 (${code})`;
  }
}

/** 格式化 HTTP 状态错误消息 */
function formatStatusError(status: number, original: string): string {
  switch (status) {
    case 400:
      return formatStructuredBadRequest(original) ?? `API 请求参数错误: ${original}`;
    case 401:
      return `API 认证失败。请检查 .env 中的 API key 配置。`;
    case 403:
      return `API 权限不足。请检查 API key 权限或配额。`;
    case 404:
      return `API 端点不存在。请检查模型名称或 API 地址配置。`;
    case 429:
      return `API 请求频率超限`;
    case 500:
      return `API 服务器内部错误`;
    case 502:
      return `API 网关错误`;
    case 503:
      return `API 服务暂时不可用`;
    case 529:
      return `API 服务暂时过载 (Anthropic overloaded)`;
    default:
      if (status >= 500) {
        return `API 服务器错误 (HTTP ${status})`;
      }
      return `API 错误 (HTTP ${status}): ${original}`;
  }
}

/** 格式化未知错误消息 */
function formatUnknownError(original: string): string {
  // 简化常见的模糊错误消息
  if (/fetch failed/i.test(original)) {
    return `网络连接失败`;
  }
  if (/terminated|stream.*closed|connection.*closed/i.test(original)) {
    return `连接意外中断`;
  }
  if (/overloaded/i.test(original)) {
    return `API 服务过载`;
  }
  return `请求失败 (${original})`;
}

/**
 * 格式化 LLM 错误为友好消息
 */
export function formatLLMError(err: unknown): string {
  const classified = classifyLLMError(err);
  return classified.error.message;
}

/**
 * 判断错误是否可重试
 * 设计：除了明确的 terminal 错误，其他都可重试
 */
export function isRetryable(err: unknown): boolean {
  const classified = classifyLLMError(err);
  return classified.kind === "retryable";
}

/**
 * 获取建议的重试延迟（如果错误中包含）
 */
export function getRecommendedDelay(err: unknown): number | undefined {
  if (err instanceof RetryableLLMError) return err.retryDelayMs;
  const classified = classifyLLMError(err);
  if (classified.kind === "retryable") return classified.error.retryDelayMs;
  return undefined;
}

/** Build and throw an annotated HTTP API error with retry-after support. */
export function throwHttpApiError(
  res: Response, text: string, provider: string, model: string,
): never {
  const err = new Error(
    `${provider} API error ${res.status}: ${text.slice(0, 500)}`,
  );
  (err as any).status = res.status;
  annotateLLMError(err, { provider, model });
  (err as any).responseText = text;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      (err as any).retryAfterMs = seconds * 1000;
    }
  }
  throw err;
}
