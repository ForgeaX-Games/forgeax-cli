/**
 * 长历史 resume 回归 —— 真 PTY + 真 Ink TUI 启动 `--resume`，验证完整 WAL 被恢复并
 * 全量 materialize 到终端 scrollback，用户向上滚动时能看到恢复会话的所有历史。
 *
 * 证据来自 pyte.HistoryScreen 的 scrollback + 当前 screen：最早/末尾 marker、恢复通知和
 * 输入 chrome 都必须可见，且中间历史 marker 数量完整。缺 python3/pyte 时 graceful skip。
 */
import { test, expect, describe } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir;
const CORE_ROOT = join(HERE, '..', '..');
const TTYDRIVE = join(HERE, 'ttydrive.py');
const python = Bun.which('python3');
const hasPyte =
  python != null &&
  Bun.spawnSync([python, '-c', 'import pyte, pyte.screens; pyte.HistoryScreen']).exitCode === 0;

function writeLongWal(sessionsDir: string, sessionId: string, turns: number): void {
  const dir = join(sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const events = Array.from({ length: turns }, (_, i) => [
    {
      type: 'user_prompt.submit',
      ts: i * 2,
      payload: { prompt: i === 0 ? 'PTY-EARLY-MARKER' : `PTY-HISTORY-USER-${i.toString().padStart(3, '0')}` },
    },
    {
      type: 'assistant.message',
      ts: i * 2 + 1,
      payload: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: i === turns - 1 ? 'PTY-LATEST-MARKER' : `PTY-HISTORY-ASSISTANT-${i.toString().padStart(3, '0')}`,
        }],
      },
    },
  ]).flat();
  writeFileSync(join(dir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

async function driveResume(): Promise<{ output: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-resume-e2e-'));
  try {
    const sessionsDir = join(dir, 'sessions');
    writeLongWal(sessionsDir, 'long-session', 120);
    const stepFile = join(dir, 'step.json');
    writeFileSync(
      stepFile,
      JSON.stringify({
        cmd: ['bun', 'src/cli/main.ts', '--demo', '--no-memory', '--resume', 'long-session'],
        env: {
          ANTHROPIC_API_KEY: '',
          FORGEAX_NO_TUI: '',
          FORGEAX_SKIP_TRUST: '1',
          FORGEAX_SESSIONS_DIR: sessionsDir,
          FORGEAX_CONFIG_DIR: join(dir, 'config'),
        },
        history: 2000,
        boot_ms: 3500,
        // 已提交历史由终端 reflow；Ink 只按新宽度重画动态输入区。窄→宽覆盖两个方向，
        // 若 resize 清 scrollback 或重挂载 Static，下面的 marker 完整性/唯一性断言会失败。
        steps: [
          { resize: { rows: 24, cols: 62 }, then_ms: 700 },
          { resize: { rows: 24, cols: 100 }, then_ms: 700 },
        ],
        settle_ms: 1200,
      }),
    );
    const proc = Bun.spawn([python!, TTYDRIVE, '24', '100', stepFile], {
      cwd: CORE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { output: `${output}\n${stderr}`, exitCode };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function countHistoryMarkers(text: string): number {
  return [...text.matchAll(/PTY-HISTORY-(?:USER|ASSISTANT)-\d{3}/g)].length;
}

describe.skipIf(!hasPyte)('TUI long resume e2e (real Ink TUI under a PTY)', () => {
  test(
    'restores the full WAL into terminal scrollback',
    async () => {
      const { output, exitCode } = await driveResume();
      expect(exitCode).toBe(0);
      expect(output).toContain('==== SCROLLBACK');
      expect(output).toContain('PTY-LATEST-MARKER');
      expect(output).toContain('240 条');
      expect(output).toContain('/help');
      expect(output).toContain('PTY-EARLY-MARKER');
      expect(output.match(/PTY-EARLY-MARKER/g)).toHaveLength(1);
      expect(output.match(/PTY-LATEST-MARKER/g)).toHaveLength(1);
      // 120 轮中首轮 user 与末轮 assistant 使用独立 marker，剩余应有 238 条通用 marker；
      // resize 后仍恰好各一份，证明没有 Static 重放造成的重复，也没有清 scrollback 截断历史。
      expect(countHistoryMarkers(output)).toBe(238);
    },
    30_000,
  );
});
