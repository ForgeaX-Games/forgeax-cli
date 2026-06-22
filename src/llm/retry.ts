/** LLM 调用重试包装器 — 指数退避 + jitter + 错误分类 */

import { classifyLLMError, getRecommendedDelay } from "./errors.js";
import { sleep } from "../utils.js";

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  error: Error;
  delayMs: number;
  willRetry: boolean;
}

export interface RetryOptions {
  /** 最大重试次数，默认 5 */
  maxRetries?: number;
  /** 基础延迟（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 最大延迟（毫秒），默认 30000 */
  maxDelayMs?: number;
  /** 是否启用 jitter（+0~25%），默认 true */
  jitter?: boolean;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 重试回调 */
  onRetry?: (info: RetryInfo) => void;
}

/**
 * 计算带 jitter 的延迟时间
 */
export function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
  recommendedDelay?: number,
): number {
  // 如果有服务器建议的延迟，优先使用
  if (recommendedDelay !== undefined && recommendedDelay > 0) {
    return Math.min(recommendedDelay, maxDelayMs);
  }

  // 指数退避：1s → 2s → 4s → 8s → ...
  let delay = baseDelayMs * Math.pow(2, attempt);

  // 应用上限
  delay = Math.min(delay, maxDelayMs);

  // 应用 jitter（+0~25%，单向，确保不低于指数退避基准）
  if (jitter && delay > 0) {
    const jitterFactor = 0.25;
    delay += delay * jitterFactor * Math.random();
  }

  return Math.round(delay);
}


/**
 * 重试包装器
 *
 * 使用 classifyLLMError 判断错误类型：
 * - terminal: 直接抛出（用户取消、4xx 客户端错误）
 * - retryable: 重试（其他所有错误，包括网络、5xx、未知）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 5,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = true,
    signal,
    onRetry,
  } = opts;

  for (let attempt = 0; ; attempt++) {
    // 检查取消
    if (signal?.aborted) {
      throw new Error("Request cancelled");
    }

    try {
      return await fn();
    } catch (err: unknown) {
      const classified = classifyLLMError(err);

      // 主动取消 / 终端错误：不重试
      if (classified.kind === "aborted" || classified.kind === "terminal") {
        throw classified.error;
      }

      // 超过重试次数
      if (attempt >= maxRetries) {
        throw classified.error;
      }

      // 计算延迟
      const recommendedDelay = getRecommendedDelay(err);
      const delayMs = calculateDelay(
        attempt,
        baseDelayMs,
        maxDelayMs,
        jitter,
        recommendedDelay,
      );

      // 回调通知
      onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        error: classified.error,
        delayMs,
        willRetry: true,
      });

      // 等待重试
      await sleep(delayMs, signal);
    }
  }
}

