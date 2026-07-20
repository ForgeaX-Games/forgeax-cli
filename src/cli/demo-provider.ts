/**
 * --demo 用的内置 provider:不打网络,回显一句,证明 CLI/TUI 形态闭环(免 API key)。
 *
 * 从 cli/main.ts 抽出,供 main.ts(headless)与 host-context(TUI driver)共用。
 * Boundary(HOST 层):仅 core 相对 import。
 */
import type { LLMProvider, ProviderStreamEvent, Usage } from '../provider/types';
import { EMPTY_USAGE } from '../provider/types';

/** 把文本切成 ~n 字符的小块(模拟 content_block_delta 分块下发)。 */
function chunk(text: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out.length ? out : [''];
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'aborted');
  error.name = 'AbortError';
  return error;
}

export function demoProvider(): LLMProvider {
  return {
    api: 'demo',
    async *stream(req, opts): AsyncIterable<ProviderStreamEvent> {
      const last = req.messages.at(-1);
      const input = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      const text = `forgeax-core(demo) 收到: ${input}`;
      // 逐块下发:让 TUI 走真流式路径(delta → assistant 收口)。
      //   人眼观察节奏可选:FORGEAX_DEMO_STREAM_DELAY_MS 拉开每块间隔(默认 0 —— 不引入
      //   人为延时,免拖慢时序敏感的 --demo e2e 测试)。视觉验证时设 40 即可看到"边写边出"。
      const delayMs = Number(process.env.FORGEAX_DEMO_STREAM_DELAY_MS ?? '0') || 0;
      if (opts.signal.aborted) throw abortError(opts.signal);
      yield { type: 'message_start', usage: EMPTY_USAGE as Usage };
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      for (const piece of chunk(text, 6)) {
        if (opts.signal.aborted) throw abortError(opts.signal);
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } };
        if (delayMs > 0) await waitForDelay(delayMs, opts.signal);
      }
      yield { type: 'content_block_stop', index: 0, block: { type: 'text', text } };
      yield { type: 'message_delta', usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
      // 最终整块 assistant(收口契约不变:driver/reduce 据此落 durable 条目)。
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}
