import { expect, test } from 'bun:test';
import { QueuedEvents } from '../src/kernel-facade/queued-events';

test('start wakes the consumer before a pending summary finishes', async () => {
  const queue = new QueuedEvents<string>();
  let complete!: () => void;
  const summary = new Promise<void>(resolve => { complete = resolve; });
  async function* source() {
    queue.push('started');
    await summary;
    queue.push('completed');
    yield 'answer';
  }
  const stream = queue.interleave(source());
  expect((await stream.next()).value).toEqual({ queued: 'started' });
  complete();
  expect((await stream.next()).value).toEqual({ queued: 'completed' });
  expect((await stream.next()).value).toEqual({ native: 'answer' });
  expect((await stream.next()).done).toBe(true);
});

test('disposal while source is pending settles without waiting for provider and closes source', async () => {
  const queue = new QueuedEvents<string>();
  let settle!: () => void;
  let closed = false;
  const pending = new Promise<void>(resolve => { settle = resolve; });
  async function* source() {
    try { queue.push('started'); await pending; yield 'answer'; }
    finally { closed = true; }
  }
  const stream = queue.interleave(source());
  await stream.next();
  expect((await stream.return(undefined as never)).done).toBe(true);
  settle();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(closed).toBe(true);
});

test('queued terminal status precedes generator failure and does not swallow it', async () => {
  const queue = new QueuedEvents<string>();
  async function* source(): AsyncGenerator<string> { queue.push('failed'); throw new Error('provider failure'); }
  const stream = queue.interleave(source());
  expect((await stream.next()).value).toEqual({ queued: 'failed' });
  await expect(stream.next()).rejects.toThrow('provider failure');
});


test('native rejection is handled while consumer is paused at queued output', async () => {
  const queue = new QueuedEvents<string>();
  queue.push('started');
  async function* source(): AsyncGenerator<string> { throw new Error('pending failure'); }
  const stream = queue.interleave(source());
  expect((await stream.next()).value).toEqual({ queued: 'started' });
  // Bun reports any unhandled rejection during this backpressure window.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((await stream.return(undefined as never)).done).toBe(true);
});
