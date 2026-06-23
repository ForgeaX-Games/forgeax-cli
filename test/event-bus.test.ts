/**
 * Phase D5 — EventBus tests. Covers fanout, glob patterns, recent ring buffer,
 * journal sink, threadId propagation, and tool.* auto-emit from callTool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEventBus, _resetEventBusForTests, type EventEnvelope } from '../src/events/bus';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';
import { _setSnapshotForTests, _resetSnapshotForTests } from '../src/plugins/registry';
import { callTool, _resetToolHandlerCacheForTests } from '../src/tools/registry';

beforeEach(() => {
  _resetEventBusForTests();
});

describe('EventBus', () => {
  it('fans out to exact-topic subscribers', () => {
    const bus = getEventBus();
    const got: EventEnvelope[] = [];
    const unsub = bus.subscribe('hello', (e) => got.push(e));
    bus.emit('hello', { x: 1 });
    bus.emit('other', {});
    unsub();
    bus.emit('hello', { x: 2 });
    expect(got).toHaveLength(1);
    expect(got[0].payload).toEqual({ x: 1 });
  });

  it('matches glob patterns: foo.*', () => {
    const bus = getEventBus();
    const got: string[] = [];
    bus.subscribe('foo.*', (e) => got.push(e.topic));
    bus.emit('foo.bar', null);
    bus.emit('foo.baz', null);
    bus.emit('foo.bar.qux', null); // should NOT match (multi-segment)
    bus.emit('other', null);
    expect(got).toEqual(['foo.bar', 'foo.baz']);
  });

  it('matches ** as multi-segment wildcard', () => {
    const bus = getEventBus();
    const got: string[] = [];
    bus.subscribe('foo.**', (e) => got.push(e.topic));
    bus.emit('foo.bar', null);
    bus.emit('foo.bar.baz', null);
    expect(got).toEqual(['foo.bar', 'foo.bar.baz']);
  });

  it('matches colon-separated namespaces', () => {
    const bus = getEventBus();
    const got: string[] = [];
    bus.subscribe('wb-character:*', (e) => got.push(e.topic));
    bus.emit('wb-character:save', null);
    bus.emit('wb-character:list', null);
    bus.emit('wb-other:save', null);
    expect(got).toEqual(['wb-character:save', 'wb-character:list']);
  });

  it('recent() returns matching events in chronological order', () => {
    const bus = getEventBus();
    bus.emit('a', 1);
    bus.emit('b', 2);
    bus.emit('a', 3);
    const recent = bus.recent('a', 5);
    expect(recent.map((e) => e.payload)).toEqual([1, 3]);
    const recentAll = bus.recent('*', 10);
    expect(recentAll.map((e) => e.topic)).toEqual(['a', 'b', 'a']);
  });

  it('recent() limits by n', () => {
    const bus = getEventBus();
    for (let i = 0; i < 20; i += 1) bus.emit('t', i);
    const r = bus.recent('t', 5);
    expect(r.map((e) => e.payload)).toEqual([15, 16, 17, 18, 19]);
  });

  it('records threadId on envelope', () => {
    const bus = getEventBus();
    const env = bus.emit('x', null, { threadId: 'th-1' });
    expect(env.threadId).toBe('th-1');
    const env2 = bus.emit('x', null);
    expect(env2.threadId).toBeNull();
  });

  it('journal sink receives every emit', () => {
    const bus = getEventBus();
    const journaled: EventEnvelope[] = [];
    bus.setJournalSink((e) => journaled.push(e));
    bus.emit('a', 1);
    bus.emit('b', 2);
    expect(journaled.map((e) => e.topic)).toEqual(['a', 'b']);
  });

  it('isolates subscriber crashes', () => {
    const bus = getEventBus();
    const got: number[] = [];
    bus.subscribe('x', () => { throw new Error('boom'); });
    bus.subscribe('x', (e) => got.push(e.payload as number));
    bus.emit('x', 7);
    expect(got).toEqual([7]);
  });
});

describe('callTool auto-emit', () => {
  const TMP = `/tmp/forgeax-bus-tools-${process.pid}`;

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
    _resetSnapshotForTests();
    _resetToolHandlerCacheForTests();
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    _resetSnapshotForTests();
    _resetToolHandlerCacheForTests();
  });

  async function setupTool(handler: string) {
    // Bun caches dynamic-import modules by URL — use a unique filename per
    // test so a second setupTool call in the same suite doesn't return a
    // stale module body. (forgeax-plugin.json is rebuilt to point at the
    // new file.)
    const handlerName = `h-${crypto.randomUUID()}.mjs`;
    const dir = join(TMP, 'L1', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'forgeax-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: '0.1.0',
        id: '@x/demo',
        kind: 'tool',
        displayName: { zh: 'd', en: 'd' },
        entry: { backend: `./${handlerName}` },
        provides: { tools: [{ id: 'd.go', exposedToAI: true }] },
      }),
      'utf-8',
    );
    writeFileSync(join(dir, handlerName), handler, 'utf-8');
    const scan = await scanAllLayers({ L0: join(TMP, 'L0'), L1: join(TMP, 'L1'), L2: join(TMP, 'L2') });
    const merge = mergeManifests(scan.found);
    const kinds = buildKindRegistry(merge.manifests);
    _setSnapshotForTests({
      generation: 1,
      loadedAt: Date.now(),
      manifests: merge.manifests,
      kinds,
      scanErrors: scan.errors,
      mergeIssues: merge.issues,
    });
  }

  it('emits tool.starting + tool.completed on success', async () => {
    await setupTool(`export default { 'd.go': async () => 42 };\n`);
    const got: string[] = [];
    getEventBus().subscribe('tool.*', (e) => got.push(e.topic));
    const r = await callTool({ toolId: 'd.go', args: {}, caller: { kind: 'user', threadId: 'th-7' } });
    expect(r.ok).toBe(true);
    expect(got).toEqual(['tool.starting', 'tool.completed']);
  });

  it('emits tool.failed on handler exception', async () => {
    await setupTool(`export default { 'd.go': () => { throw new Error('nope'); } };\n`);
    const got: string[] = [];
    getEventBus().subscribe('tool.*', (e) => got.push(e.topic));
    const r = await callTool({ toolId: 'd.go', args: {}, caller: { kind: 'user' } });
    expect(r.ok).toBe(false);
    expect(got).toEqual(['tool.starting', 'tool.failed']);
  });

  it('emits tool.failed on not_found without tool.starting', async () => {
    await setupTool(`export default { 'd.go': () => 1 };\n`);
    const got: string[] = [];
    getEventBus().subscribe('tool.*', (e) => got.push(e.topic));
    await callTool({ toolId: 'no.such', args: {}, caller: { kind: 'user' } });
    expect(got).toEqual(['tool.failed']);
  });

  it('propagates threadId from caller into envelope', async () => {
    await setupTool(`export default { 'd.go': () => 1 };\n`);
    const got: EventEnvelope[] = [];
    getEventBus().subscribe('tool.completed', (e) => got.push(e));
    await callTool({ toolId: 'd.go', args: {}, caller: { kind: 'user', threadId: 'thread-X' } });
    expect(got[0].threadId).toBe('thread-X');
  });
});
