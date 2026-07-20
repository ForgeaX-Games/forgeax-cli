/**
 * useStreamingText —— 流式 assistant 文本的「累积 + 节流重渲」(throttled-markdown:
 * 固定 ~200ms 提交一次,新段落 / 非追加改写 / 首帧立即刷)。
 *
 * 为什么:provider 逐字吐 `content_block_delta`,但 transcript 的 reduce 丢弃 `stream`
 * 事件,只有每轮最后的 `assistant` 事件整块渲染 → 文本「一坨蹦出来」。本 hook 把 delta
 * 累积成一个 ephemeral 字符串(**不进 session 日志**,避免 reduce 每帧 O(n²) 空扫),
 * 以 ≤5fps 节流重渲,给出连续流出的观感;`assistant` 事件到达即 finalize(清空,由
 * durable 条目接管,视觉零跳变)。
 *
 * 设计遵循本仓「纯逻辑 + 薄 React 壳」惯例(见 input/promptReducer、input/router):
 *   - `extractStreamTextDelta` / `shouldCommitStream` 是纯函数,单测覆盖。
 *   - `useStreamingText` 只做 state/timer 编排。
 *
 * 开关:`FORGEAX_NO_STREAM=1` 关闭(调用方据此不 feed → 回退旧的整块渲染);
 *       `FORGEAX_STREAM_THROTTLE_MS` 调节流窗口(默认 200)。
 *
 * Boundary(HOST 层):react + core 相对 import。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../contracts';

/** 默认节流窗口(ms):~200ms 提交一次,平衡流出观感与重渲开销。 */
export const DEFAULT_STREAM_THROTTLE_MS = 200;

/** 流式总开关:`FORGEAX_NO_STREAM=1` → false(回退整块渲染)。 */
export function streamingEnabled(): boolean {
  return process.env.FORGEAX_NO_STREAM !== '1';
}

/** 生效节流窗口:env 覆盖 → 合法正数否则默认。 */
export function streamThrottleMs(): number {
  const raw = process.env.FORGEAX_STREAM_THROTTLE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_STREAM_THROTTLE_MS;
}

/**
 * 从一个 AgentEvent 抽「文本 delta」。只认 `stream` → `content_block_delta` →
 * `text_delta`(delta.text);thinking / partial_json / 其它一律返回 ''。
 * delta 形状见 provider/anthropic.ts(content_block_delta 分支)。
 */
export function extractStreamTextDelta(e: AgentEvent): string {
  if (!e || e.type !== 'stream') return '';
  const sev = (e as { event?: unknown }).event as
    | { type?: string; delta?: { type?: string; text?: string } }
    | undefined;
  if (!sev || sev.type !== 'content_block_delta') return '';
  const d = sev.delta;
  if (!d || d.type !== 'text_delta' || typeof d.text !== 'string') return '';
  return d.text;
}

/**
 * 从一个 AgentEvent 抽「thinking delta」。只认 `stream` → `content_block_delta` →
 * `thinking_delta`(delta.thinking);text / signature / partial_json / 其它一律 ''。
 * 与 `extractStreamTextDelta` 对称(F2:thinking 也走同一 useStreamingText 节流通道,
 * 「先流式显示 → 轮末由折叠 ThinkingView 接管」)。delta 形状见 provider/anthropic.ts。
 */
export function extractStreamThinkingDelta(e: AgentEvent): string {
  if (!e || e.type !== 'stream') return '';
  const sev = (e as { event?: unknown }).event as
    | { type?: string; delta?: { type?: string; thinking?: string } }
    | undefined;
  if (!sev || sev.type !== 'content_block_delta') return '';
  const d = sev.delta;
  if (!d || d.type !== 'thinking_delta' || typeof d.thinking !== 'string') return '';
  return d.thinking;
}

/** 段落数(按空行分段);用于「新段落出现 → 立即刷」判定。 */
function paragraphCount(s: string): number {
  if (s === '') return 0;
  return s.split(/\n\s*\n/).length;
}

/**
 * 是否应把 `raw` 立即提交为可见文本(throttled-markdown 判定):
 *   - raw === shown            → 无变化,false
 *   - !raw.startsWith(shown)    → 非追加改写(如 finalize 后重开),立即刷 true
 *   - 段落数增加               → 有新段落收尾,立即刷 true(观感更跟手)
 *   - now - lastAt >= throttle → 到节流窗口,true
 *   - 否则                     → false(由调用方 setTimeout 到窗口边界补刷)
 */
export function shouldCommitStream(
  raw: string,
  shown: string,
  lastAt: number,
  now: number,
  throttleMs: number,
): boolean {
  if (raw === shown) return false;
  if (!raw.startsWith(shown)) return true;
  if (paragraphCount(raw) > paragraphCount(shown)) return true;
  return now - lastAt >= throttleMs;
}

export interface StreamingText {
  /** 当前应显示的(节流后的)文本;空串 = 无在写文本。 */
  displayText: string;
  /** 追加一段 delta 文本(累积 + 按需节流刷新 displayText)。 */
  feed(delta: string): void;
  /** 收口:清空并返回截至此刻的**全量**累积文本(调用方决定是否落 durable 条目)。 */
  finalize(): string;
  /** 硬复位(/clear、resume、rewind、turn 开始):清 timer + 清空。 */
  reset(): void;
}

/** 单调时钟(ms);无 performance 时回退 Date.now。 */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** 流式文本 hook:累积 delta,≤throttleMs 提交一次可见文本。 */
export function useStreamingText(throttleMs: number = streamThrottleMs()): StreamingText {
  const [displayText, setDisplayText] = useState('');
  const rawRef = useRef('');
  const shownRef = useRef(''); // 与 displayText 同步(避免闭包读旧值)
  const lastAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const commit = useCallback(() => {
    clearTimer();
    shownRef.current = rawRef.current;
    lastAtRef.current = nowMs();
    setDisplayText(rawRef.current);
  }, [clearTimer]);

  const feed = useCallback(
    (delta: string) => {
      if (!delta) return;
      rawRef.current += delta;
      const now = nowMs();
      if (shouldCommitStream(rawRef.current, shownRef.current, lastAtRef.current, now, throttleMs)) {
        commit();
      } else if (!timerRef.current) {
        const wait = Math.max(0, throttleMs - (now - lastAtRef.current));
        timerRef.current = setTimeout(commit, wait);
      }
    },
    [commit, throttleMs],
  );

  const finalize = useCallback((): string => {
    clearTimer();
    const full = rawRef.current;
    rawRef.current = '';
    shownRef.current = '';
    lastAtRef.current = 0;
    setDisplayText('');
    return full;
  }, [clearTimer]);

  const reset = useCallback((): void => {
    clearTimer();
    rawRef.current = '';
    shownRef.current = '';
    lastAtRef.current = 0;
    setDisplayText('');
  }, [clearTimer]);

  // unmount 清 timer(防泄漏 / setState-after-unmount)。
  useEffect(() => clearTimer, [clearTimer]);

  return { displayText, feed, finalize, reset };
}
