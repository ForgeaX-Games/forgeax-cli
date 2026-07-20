import { describe, expect, test } from 'bun:test';
import { foldEvents, type EventRange, type FoldAdapter } from '../src/history/ledger';
import type { CoreEvent } from '../src/events/types';

// Minimal test vocabulary: a "Message" event carries { id, text }; a
// "CompactionApplied" carries { id, range, summary }; "CompactionRevoked"
// carries { targetId }.
function msg(id: string, text: string): CoreEvent {
  return { type: 'Message', ts: 0, payload: { id, text } };
}
function applied(id: string, range: EventRange, summary: string): CoreEvent {
  return { type: 'CompactionApplied', ts: 0, payload: { id, range, summary } };
}
function revoked(targetId: string): CoreEvent {
  return { type: 'CompactionRevoked', ts: 0, payload: { targetId } };
}
// rewind:遮蔽区间(无 replacement),可撤销。
function rewApplied(id: string, range: EventRange): CoreEvent {
  return { type: 'RewindApplied', ts: 0, payload: { id, range } };
}
function rewRevoked(targetId: string): CoreEvent {
  return { type: 'RewindRevoked', ts: 0, payload: { targetId } };
}

const adapter: FoldAdapter<string> = {
  isMessage: (e) => e.type === 'Message',
  toMessage: (e) => (e.payload as { text: string }).text,
  eventId: (e) => String((e.payload as { id?: string }).id ?? ''),
  isCompactionApplied: (e) => e.type === 'CompactionApplied',
  isCompactionRevoked: (e) => e.type === 'CompactionRevoked',
  appliedRange: (e) => (e.payload as { range: EventRange }).range,
  appliedReplacement: (e) => (e.payload as { summary: string }).summary,
  revokedAppliedId: (e) => (e.payload as { targetId: string }).targetId,
  isRewindApplied: (e) => e.type === 'RewindApplied',
  isRewindRevoked: (e) => e.type === 'RewindRevoked',
  rewindRange: (e) => (e.payload as { range: EventRange }).range,
  revokedRewindId: (e) => (e.payload as { targetId: string }).targetId,
};

describe('foldEvents', () => {
  test('no compaction → messages project through in order', () => {
    const events = [msg('1', 'hello'), msg('2', 'world')];
    expect(foldEvents(events, adapter)).toEqual(['hello', 'world']);
  });

  test('non-message events are skipped', () => {
    const events = [msg('1', 'a'), { type: 'noise', ts: 0, payload: {} }, msg('2', 'b')];
    expect(foldEvents(events, adapter)).toEqual(['a', 'b']);
  });

  test('byIndex range → replacement at first covered, skip rest', () => {
    // events[1..2] (msgs 2 and 3) compacted into "[summary]"
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      msg('4', 'd'),
      applied('C', { kind: 'byIndex', from: 1, to: 2 }, '[summary]'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', '[summary]', 'd']);
  });

  test('byEventId range', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      applied('C', { kind: 'byEventId', ids: ['2', '3'] }, '[s]'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', '[s]']);
  });

  test('revoked compaction → original messages restored', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      applied('C', { kind: 'byEventId', ids: ['1', '2'] }, '[s]'),
      revoked('C'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', 'b']);
  });

  test('overlapping ranges resolve last-wins', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      applied('A', { kind: 'byEventId', ids: ['1', '2'] }, '[A]'),
      applied('B', { kind: 'byEventId', ids: ['2', '3'] }, '[B]'),
    ];
    // 1 covered by A only → [A]; 2 last-covered by B → [B]; 3 by B (already emitted) → skip
    expect(foldEvents(events, adapter)).toEqual(['[A]', '[B]']);
  });

  test('all range collapses everything to one replacement', () => {
    const events = [msg('1', 'a'), msg('2', 'b'), applied('C', { kind: 'all' }, '[everything]')];
    expect(foldEvents(events, adapter)).toEqual(['[everything]']);
  });
});

// ─── H-01: rewind 遮蔽(无 replacement,与 compaction 的替换语义区别)──────────────
describe('foldEvents — rewind mask', () => {
  test('rewind range → covered messages skipped entirely (no replacement)', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      rewApplied('R', { kind: 'byEventId', ids: ['2', '3'] }),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a']);
  });

  test('revoked rewind → messages restored', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      rewApplied('R', { kind: 'byEventId', ids: ['2', '3'] }),
      rewRevoked('R'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', 'b', 'c']);
  });

  test('rewind is judged before compaction: a compaction inside a rewound range is fully masked', () => {
    // 嵌套:rewind 区间 [2..4] 内含 compaction 区间 [3..4]。rewind 先判 → 2/3/4 全遮蔽,
    // compaction 的 replacement 也不产出(其锚点消息被 rewind 吃掉)。
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      msg('4', 'd'),
      applied('C', { kind: 'byEventId', ids: ['3', '4'] }, '[compact]'),
      rewApplied('R', { kind: 'byEventId', ids: ['2', '3', '4'] }),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a']);
  });

  test('rewound then revoked with compaction still applied inside', () => {
    // rewind 撤销后,内层 compaction 恢复生效:2 保留、3/4 压成 [compact]。
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      msg('4', 'd'),
      applied('C', { kind: 'byEventId', ids: ['3', '4'] }, '[compact]'),
      rewApplied('R', { kind: 'byEventId', ids: ['2', '3', '4'] }),
      rewRevoked('R'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', 'b', '[compact]']);
  });
});
