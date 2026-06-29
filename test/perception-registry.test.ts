/** perception-registry 单测(R5/M8 地基切片)。
 *
 *  覆盖:
 *  - 取数往返:register → resolve 命中(snapshot 原样回);未知 reqId resolve→false。
 *  - 取数超时:无人 resolve → fail-soft 返回 { unavailable, reason:'timeout' }(不挂死)。
 *  - L1 缓冲:push → drain 一次拿全部 + 清空;超上限 FIFO 丢旧;空/无 sid 安全。
 */
import { describe, expect, test } from 'bun:test';
import {
  registerPerception,
  resolvePerception,
  pushPerceptionNote,
  drainPerceptionNotes,
} from '../src/api/lib/perception-registry';

describe('perception-registry · 取数往返', () => {
  test('register → resolve 命中,snapshot 原样回', async () => {
    const handle = registerPerception('r-1', 5_000);
    const snap = { entityCount: 3, archetypes: [] };
    expect(resolvePerception('r-1', snap)).toBe(true);
    await expect(handle.promise).resolves.toEqual(snap);
    handle.dispose();
  });

  test('未知 reqId resolve → false', () => {
    expect(resolvePerception('nope', {})).toBe(false);
  });

  test('超时 → fail-soft { unavailable, timeout }(不 reject)', async () => {
    const handle = registerPerception('r-timeout', 20);
    const out = (await handle.promise) as { unavailable?: boolean; reason?: string };
    expect(out.unavailable).toBe(true);
    expect(out.reason).toBe('timeout');
    handle.dispose();
  });
});

describe('perception-registry · L1 回灌缓冲', () => {
  test('push → drain 拿全部并清空', () => {
    pushPerceptionNote('sid-A', { level: 'error', text: 'boom', ts: 1 });
    pushPerceptionNote('sid-A', { level: 'warn', text: 'careful', ts: 2 });
    const first = drainPerceptionNotes('sid-A');
    expect(first.map((n) => n.text)).toEqual(['boom', 'careful']);
    // drain 清空 → 第二次为空
    expect(drainPerceptionNotes('sid-A')).toEqual([]);
  });

  test('超上限 FIFO 丢旧(保留最新 10 条)', () => {
    for (let i = 0; i < 15; i++) pushPerceptionNote('sid-B', { level: 'error', text: `e${i}`, ts: i });
    const drained = drainPerceptionNotes('sid-B');
    expect(drained).toHaveLength(10);
    expect(drained[0]!.text).toBe('e5'); // e0..e4 dropped
    expect(drained[9]!.text).toBe('e14');
  });

  test('空 text / 无 sid 安全(忽略)', () => {
    pushPerceptionNote('sid-C', { level: 'error', text: '   ', ts: 0 });
    pushPerceptionNote('', { level: 'error', text: 'x', ts: 0 });
    expect(drainPerceptionNotes('sid-C')).toEqual([]);
    expect(drainPerceptionNotes(undefined)).toEqual([]);
  });
});
