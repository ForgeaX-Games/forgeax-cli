/**
 * 流式空闲看门狗(cc 对齐)——直接钉住「何时抛 StreamIdleError」与阈值 clamp 语义。
 * stream-retry.test.ts 覆盖「拿到 StreamIdleError 之后」的重发决策;本文件覆盖「之前」:
 *   ① providerStreamIdleMs 的 default/关闭/clamp 三态(对齐 cc 的 5min 默认 + [10s,30min] clamp);
 *   ② readWithIdleTimeout 在无字节超时时抛 StreamIdleError 且 cancel reader,正常到达则原样返回不 cancel。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { parseSSE, providerStreamIdleMs, readWithIdleTimeout } from '../src/provider/anthropic';
import { StreamIdleError, type ProviderStreamEvent } from '../src/provider/types';
import { demoProvider } from '../src/cli/demo-provider';

const ENV = 'FORGEAX_PROVIDER_IDLE_MS';
const savedEnv = process.env[ENV];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe('providerStreamIdleMs', () => {
  test('unset → 默认 300000(cc 5min)', () => {
    delete process.env[ENV];
    expect(providerStreamIdleMs()).toBe(300_000);
  });
  test('0 → 关闭(escape hatch)', () => {
    process.env[ENV] = '0';
    expect(providerStreamIdleMs()).toBe(0);
  });
  test('负/非法 → 回默认', () => {
    process.env[ENV] = '-5';
    expect(providerStreamIdleMs()).toBe(300_000);
    process.env[ENV] = 'abc';
    expect(providerStreamIdleMs()).toBe(300_000);
  });
  test('界内值原样', () => {
    process.env[ENV] = '60000';
    expect(providerStreamIdleMs()).toBe(60_000);
  });
  test('低于下界 → clamp 到 10000(cc Zm5)', () => {
    process.env[ENV] = '5000';
    expect(providerStreamIdleMs()).toBe(10_000);
  });
  test('高于上界 → clamp 到 1800000(cc Gm5=30min)', () => {
    process.env[ENV] = '99999999';
    expect(providerStreamIdleMs()).toBe(1_800_000);
  });
});

describe('readWithIdleTimeout', () => {
  test('read 久不返回 → 抛 StreamIdleError 并 cancel reader', async () => {
    let canceled = false;
    const reader = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}), // 永不 resolve(模拟 stall)
      cancel: async () => void (canceled = true),
    };
    await expect(readWithIdleTimeout(reader, 20)).rejects.toBeInstanceOf(StreamIdleError);
    expect(canceled).toBe(true);
  });

  test('read 在超时前返回 → 原样返回,不 cancel', async () => {
    let canceled = false;
    const chunk = new Uint8Array([1, 2, 3]);
    const reader = {
      read: async () => ({ done: false, value: chunk }),
      cancel: async () => void (canceled = true),
    };
    const r = await readWithIdleTimeout(reader, 1000);
    expect(r).toEqual({ done: false, value: chunk });
    expect(canceled).toBe(false);
  });

  test('abort settles a stalled read promptly and cancels reader', async () => {
    let canceled = false;
    const reader = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
      cancel: async () => void (canceled = true),
    };
    const ac = new AbortController();
    const pending = readWithIdleTimeout(reader, 60_000, ac.signal);
    ac.abort('stop');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(canceled).toBe(true);
  });
});

describe('parseSSE cancellation cleanup', () => {
  test('abort cancels a stalled stream and releases its reader lock', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => void (canceled = true),
    });
    const ac = new AbortController();
    const iterator = parseSSE(body, 60_000, ac.signal);
    const pending = iterator.next();
    ac.abort('stop');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });
});

describe('demo provider cancellation', () => {
  test('abort interrupts the configured inter-chunk delay', async () => {
    const previous = process.env.FORGEAX_DEMO_STREAM_DELAY_MS;
    process.env.FORGEAX_DEMO_STREAM_DELAY_MS = '60000';
    const ac = new AbortController();
    const events: ProviderStreamEvent[] = [];
    try {
      const pending = (async () => {
        for await (const event of demoProvider().stream(
          { model: 'demo', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] },
          { signal: ac.signal },
        )) events.push(event);
      })();
      await Promise.resolve();
      ac.abort('stop');
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(events.some((event) => event.type === 'assistant')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_DEMO_STREAM_DELAY_MS;
      else process.env.FORGEAX_DEMO_STREAM_DELAY_MS = previous;
    }
  });
});
