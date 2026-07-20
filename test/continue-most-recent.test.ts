/**
 * H-04 — `-c/--continue` = 最近活跃会话(而非固定 `default`)。
 * 测 `mostRecentSessionId`(CLI 与 TUI /continue 的 SSOT):按 mtime 取最新;无会话 → undefined。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mostRecentSessionId, listSessions } from '../src/cli/resume-fold';

function seedSession(dir: string, id: string, mtimeSec: number): void {
  const sdir = join(dir, id);
  mkdirSync(sdir, { recursive: true });
  const f = join(sdir, 'events.jsonl');
  writeFileSync(f, JSON.stringify({ type: 'user', payload: `hi from ${id}`, ts: 0 }) + '\n');
  utimesSync(f, mtimeSec, mtimeSec); // 固定 mtime,消除写序抖动
}

describe('H-04 mostRecentSessionId', () => {
  test('多会话 → 取 mtime 最新的那个', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    try {
      seedSession(dir, 'task-A', 1_000_000);
      seedSession(dir, 'task-B', 2_000_000); // 更新
      seedSession(dir, 'task-C', 1_500_000);
      expect(listSessions(dir).map((s) => s.id)).toEqual(['task-B', 'task-C', 'task-A']);
      expect(mostRecentSessionId(dir)).toBe('task-B');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('无任何会话 → undefined(-c 回落新建,不报错)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-empty-'));
    try {
      expect(mostRecentSessionId(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
