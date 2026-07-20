/**
 * 重启后 driver 重建挂起态(验收 13.25)。
 *
 * 场景:第一个 driver 完成 rewind → 挂起态建立(checkpoints.jsonl 落盘) → dispose。
 * 再创建相同 sessionId/sessionsDir/cwd 的第二个 driver → pendingRewind() 应返回非 null。
 * finalize 后重建 → pendingRewind() 应返回 null(已定格)。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'drv-rst-'));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function driverOpts() {
  return { ...ARGS, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' };
}

async function mkDriver() {
  const opts = driverOpts();
  const host = await buildHostContext(opts);
  return createAgentDriver(opts, host);
}

describe('driver checkpoint restart (pendingRewind survives restart)', () => {
  test('pendingRewind() 在重建的 driver 上返回非 null', async () => {
    const d1 = await mkDriver();
    try {
      writeFileSync(join(tmp, 'foo.ts'), 'v1\n');
      const m1 = d1.checkpointTurn();
      expect(m1).toBeTruthy();

      writeFileSync(join(tmp, 'foo.ts'), 'v2\n');

      const r = await d1.rewind({ msgId: m1!, hasCode: true, keepUserTurns: 0, currentMessages: [] });
      expect(r).not.toHaveProperty('error');
      // 第一个 driver 挂起态已建立
      expect(d1.pendingRewind()).not.toBeNull();
    } finally {
      await d1.dispose();
    }

    // 模拟重启:创建新 driver
    const d2 = await mkDriver();
    try {
      // ★ 验收核心:重启后 pendingRewind() 应返回非 null
      const pv = d2.pendingRewind();
      expect(pv).not.toBeNull();
      expect(pv!.hasCode).toBe(true);
      expect(typeof pv!.boundaryId).toBe('string');
    } finally {
      await d2.dispose();
    }
  });

  test('pendingRewind() 在 finalize 后重建的 driver 上返回 null', async () => {
    const d1 = await mkDriver();
    try {
      writeFileSync(join(tmp, 'foo.ts'), 'v1\n');
      const m1 = d1.checkpointTurn();
      await d1.rewind({ msgId: m1!, hasCode: true, keepUserTurns: 0, currentMessages: [] });
      d1.finalizeRewind(); // 定格:挂起态消失
      expect(d1.pendingRewind()).toBeNull();
    } finally {
      await d1.dispose();
    }

    const d2 = await mkDriver();
    try {
      // finalized 后重建:应无挂起态
      expect(d2.pendingRewind()).toBeNull();
    } finally {
      await d2.dispose();
    }
  });
});
