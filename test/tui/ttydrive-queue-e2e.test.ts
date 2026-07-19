/**
 * 队列落位回归 e2e —— 真 PTY 里流式进行中排队第二条消息,断言 transcript 逐轮
 * user→回复 配对:`› SECOND-QUEUED-MSG` 落在第一轮回复(GHOST-LINE-39)**之后**、
 * 第二轮回复(第二份 GHOST-LINE-00)**之前**,且只出现一次。
 *
 * 守护的 bug(2026-07-13 修):三个入队路径在 busy 检查前就 session.push user 条目,
 * 排队消息定格在上一轮回复之前 → 顺序变成 user1, user2, 回复1, 回复2。修复 = user
 * 条目 + 回退锚点延迟到队列消费时落(Repl.tsx 队列消费 effect)。
 *
 * 复用 e2e-longstream-entry.ts(慢速流式 40 行,ignores input → 两轮各吐一份 marker)
 * 与 ttydrive.py 的 HistoryScreen 档。前置:python3 + pyte,缺任一 → skip(§9)。
 *
 * Boundary(HOST/test 层):node: + Bun + 相对路径。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir; // …/packages/cli/test/tui
const CORE_ROOT = join(HERE, '..', '..'); // …/packages/core
const TTYDRIVE = join(HERE, 'ttydrive.py');

const python = Bun.which('python3');
const hasPyte =
  python != null &&
  Bun.spawnSync([python, '-c', 'import pyte, pyte.screens; pyte.HistoryScreen']).exitCode === 0;

/** 跑「流式中途排队第二条」的会话,返回 scrollback+screen 拼接的完整可见文本。 */
async function driveQueuedTurn(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-queue-e2e-'));
  try {
    const stepFile = join(dir, 'step.json');
    writeFileSync(
      stepFile,
      JSON.stringify({
        cmd: ['bun', 'test/tui/e2e-longstream-entry.ts', '--no-memory'],
        env: {
          ANTHROPIC_API_KEY: '',
          FORGEAX_NO_TUI: '',
          FORGEAX_SKIP_TRUST: '1',
          FORGEAX_SESSIONS_DIR: join(dir, 'sessions'),
          FORGEAX_CONFIG_DIR: join(dir, 'config'),
          FORGEAX_E2E_STREAM_DELAY_MS: '60', // 40 行 × 60ms ≈ 2.4s 的 busy 窗口
        },
        history: 4000,
        boot_ms: 2500,
        steps: [
          { send: 'first message', then_ms: 300 },
          { send: '<CR>', then_ms: 800 }, // turn 1 起跑,流到 ~1/3 处
          { send: 'SECOND-QUEUED-MSG', then_ms: 300 },
          { send: '<CR>', then_ms: 9000 }, // busy 中排队;两轮(~2.4s×2)+ 收口留裕量
        ],
        settle_ms: 1500,
      }),
    );
    const proc = Bun.spawn([python!, TTYDRIVE, '24', '100', stepFile], {
      cwd: CORE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const sb = out.match(/==== SCROLLBACK[^\n]*\n([\s\S]*?)\n==== END SCROLLBACK ====/);
    const sc = out.match(/==== SCREEN[^\n]*\n([\s\S]*?)\n==== END ====/);
    return (sb ? sb[1]! : '') + '\n' + (sc ? sc[1]! : out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasPyte)('TUI queued-turn transcript order e2e (real PTY)', () => {
  test(
    'queued user entry lands between turn-1 reply and turn-2 reply (not before turn-1)',
    async () => {
      const text = await driveQueuedTurn();

      // 两轮都完整跑完:首尾 marker 各恰好两份(一轮一份 durable)。
      expect(text.match(/GHOST-LINE-00/g)?.length).toBe(2);
      expect(text.match(/GHOST-LINE-39/g)?.length).toBe(2);

      // 排队消息的 user 条目恰好一条(`› ` 前缀 = transcript 条目;pending 期间的
      // 队列预览是 `... 1. ` 前缀,且最终帧队列已清空,不会残留)。
      const userEntries = text.match(/› SECOND-QUEUED-MSG/g) ?? [];
      expect(userEntries.length).toBe(1);

      // 主断言:user2 条目在第一轮回复结束之后、第二轮回复开始之前(逐轮配对)。
      const user2At = text.indexOf('› SECOND-QUEUED-MSG');
      const turn1EndAt = text.indexOf('GHOST-LINE-39');
      const turn2StartAt = text.indexOf('GHOST-LINE-00', text.indexOf('GHOST-LINE-00') + 1);
      expect(user2At).toBeGreaterThan(turn1EndAt);
      expect(user2At).toBeLessThan(turn2StartAt);
    },
    40_000,
  );
});
