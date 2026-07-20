/**
 * T23 — streamWithRetry: retry-before-first-event, model fallback, no mid-stream retry
 *   (except StreamIdleError, which re-issues even mid-stream — cc 对齐,见下方 idle 用例)。
 */
import { test, expect, describe } from 'bun:test';
import { streamWithRetry } from '../src/provider/stream-retry';
import { FallbackTriggeredError, StreamIdleError } from '../src/provider/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent } from '../src/provider/types';

const noSleep = async () => {};
const req: ProviderRequest = { model: 'm1', system: [], tools: [], messages: [] };

function evt(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, stopReason: 'end_turn' };
}

async function drain(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('streamWithRetry', () => {
  test('retries a pre-event 503 then succeeds', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        if (n === 1) throw Object.assign(new Error('boom'), { status: 503 });
        yield evt('ok');
      },
    };
    const out = await drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep }));
    expect(n).toBe(2);
    expect(out.length).toBe(1);
  });

  test('does NOT retry once events have started (mid-stream error propagates)', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        yield evt('partial');
        throw Object.assign(new Error('mid'), { status: 503 });
      },
    };
    await expect(drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep }))).rejects.toThrow('mid');
    expect(n).toBe(1); // no retry after first event
  });

  test('FallbackTriggeredError switches to fallbackModel', async () => {
    const seen: string[] = [];
    const provider: LLMProvider = {
      api: 'x',
      async *stream(r) {
        seen.push(r.model);
        if (r.model === 'm1') throw new FallbackTriggeredError('m1', 'm2');
        yield evt('fallback-ok');
      },
    };
    let fellBack = false;
    const out = await drain(
      streamWithRetry(provider, req, { signal: new AbortController().signal, fallbackModel: 'm2', onStreamingFallback: () => (fellBack = true) }, { sleep: noSleep }),
    );
    expect(seen).toEqual(['m1', 'm2']);
    expect(fellBack).toBe(true);
    expect(out.length).toBe(1);
  });

  test('StreamIdleError re-issues even AFTER events started (cc 对齐:丢半截+重发)', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        if (n === 1) {
          yield evt('partial'); // 已 started,但 idle stall 仍可安全重发
          throw new StreamIdleError(300_000);
        }
        yield evt('ok');
      },
    };
    const out = await drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep }));
    expect(n).toBe(2); // 重发一次
    // 两次尝试的事件都会流出(attempt1 的 partial + attempt2 的 ok);状态提交方以终态 assistant 为准,
    //   重发不重复提交(loop 只在 message_stop 的聚合 assistant 事件落定 messages/convo/transcript)。
    expect(out.length).toBe(2);
    expect(out.every((e) => e.type === 'assistant')).toBe(true);
  });

  test('StreamIdleError bounded at MID_STREAM_IDLE_MAX_RETRIES then propagates', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        throw new StreamIdleError(300_000); // 每次都 idle,验证有界
      },
    };
    await expect(
      drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep, maxRetries: 10 })),
    ).rejects.toThrow(StreamIdleError);
    expect(n).toBe(3); // 首发 + 2 次有界重发(MID_STREAM_IDLE_MAX_RETRIES=2),不受 maxRetries=10 影响
  });

  test('non-retryable 400 propagates immediately', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        throw Object.assign(new Error('bad'), { status: 400 });
      },
    };
    await expect(drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep, maxRetries: 5 }))).rejects.toThrow('bad');
    expect(n).toBe(1);
  });

  test('abort settles a stalled retry delay without another attempt', async () => {
    let n = 0;
    let sleepStarted!: () => void;
    const sleeping = new Promise<void>((resolve) => (sleepStarted = resolve));
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        throw Object.assign(new Error('retry me'), { status: 503 });
      },
    };
    const ac = new AbortController();
    const pending = drain(
      streamWithRetry(provider, req, { signal: ac.signal }, {
        sleep: () => {
          sleepStarted();
          return new Promise<void>(() => {});
        },
      }),
    );
    await sleeping;
    ac.abort('stop');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(n).toBe(1);
  });
});
