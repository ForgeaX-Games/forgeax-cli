/**
 * H-02 —— /resume 重建的历史轮次恢复 msgId 锚点,历史轮的**文件回退**可用。
 *
 * 复现:旧 walEventsToUiMessages 产出的 user 条目不带 msgId → resume 后所有历史轮在
 * RewindPanel 里 hasCode=false,即使 checkpoints.jsonl 存着这些轮的 CAS 快照锚点,也只能纯
 * 对话回退。根治:msgId 写进 WAL(user_prompt.submit.msgId),rehydrate 直接还原;ordinal
 * 降级为旧 WAL 兼容 fallback。
 *
 * 测法(driver 真链路):driver1 checkpointTurn(拍 CAS + 写 checkpoints.jsonl)→ driveTurn
 * (demo,写 WAL user_prompt.submit{msgId})→ 改文件 → dispose;新建 driver2(同 session,
 * 载 checkpoints.jsonl)→ resumeSession → 历史 user 轮带 msgId 且在「有代码快照」集合内 →
 * 对该历史 msgId rewind → 盘上文件还原到 checkpoint。
 *
 * Boundary(test 层):相对 import + Bun。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'drv-resume-relink-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function mkDriver(sessionsDir: string, sessionId: string) {
  const host = await buildHostContext({ ...ARGS, sessionsDir, sessionId });
  return createAgentDriver({ ...ARGS, sessionsDir, sessionId }, host);
}

describe('H-02 resume msgId re-link(历史轮文件回退可用)', () => {
  test('resume 后历史 user 轮带 msgId 且 hasCode;对其 rewind 还原文件', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');

    // ── 进程1:一轮对话,锚点拍 foo=v1,轮后把 foo 改成 v2 ──
    const d1 = await mkDriver(sessionsDir, 's1');
    let msgId: string | null = null;
    try {
      writeFileSync(join(tmp, 'foo.ts'), 'v1\n');
      msgId = d1.checkpointTurn(); // CAS(foo=v1) + checkpoints.jsonl MessageRecord
      expect(msgId).toBeTruthy();
      await d1.driveTurn('please edit foo', () => {}, undefined, msgId!); // demo 跑一轮 → WAL 写 user_prompt.submit{msgId}
      writeFileSync(join(tmp, 'foo.ts'), 'v2\n'); // 轮后编辑
    } finally {
      await d1.dispose();
    }

    // ── 进程2(新 driver,同 session):resume → 历史轮带 msgId + hasCode → 对其 rewind ──
    const d2 = await mkDriver(sessionsDir, 's1');
    try {
      const msgs = await d2.resumeSession('s1');
      expect(msgs).not.toBeNull();
      const userTurns = msgs!.filter((m) => m.kind === 'user') as Array<{ kind: 'user'; msgId?: string }>;
      expect(userTurns.length).toBeGreaterThanOrEqual(1);
      // ★ 关键1:重建的历史 user 轮带 msgId(= 进程1 的锚点)。
      expect(userTurns[0].msgId).toBe(msgId!);
      // ★ 关键2:该 msgId 在「有代码快照」集合内(listCheckpoints hasCode)。
      const codeMsgIds = new Set(d2.listCheckpoints().filter((e) => e.hasCode).map((e) => e.msgId));
      expect(codeMsgIds.has(msgId!)).toBe(true);
      // ★ 关键3:对历史轮 rewind → 盘上文件还原到 checkpoint(v2 → v1)。
      const r = await d2.rewind({ msgId: msgId!, hasCode: true, keepUserTurns: 0, currentMessages: msgs! });
      expect(r).not.toHaveProperty('error');
      expect(readFileSync(join(tmp, 'foo.ts'), 'utf-8')).toBe('v1\n');
    } finally {
      await d2.dispose();
    }
  });
});
