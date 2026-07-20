/**
 * 残影回归 e2e —— 真 PTY(24 行矮终端)里驱动真 Ink TUI,慢速流式吐 40 条 marker 行
 * (e2e-longstream-entry.ts),用 pyte.HistoryScreen 捕获 **scrollback**,断言:
 * 每条 GHOST-LINE-NN 在「scrollback + 视口」里**恰好出现一次**(durable 那份)。
 *
 * 为什么必须看 scrollback:动态区超视口残影(2026-07-13 报告)的证据只堆在 scrollback
 * 里 —— Ink 每帧擦不净溢出视口顶部的行,每个 ~200ms 节流帧都留一份旧帧拷贝;视口内
 * 断言(ttydrive 默认档)看不见它。修复 = Transcript 对在写文本做尾部视口裁剪
 * (stream-tail.ts),动态区恒压在一屏内。
 *
 * 前置:python3 + pyte(HistoryScreen 档)。缺任一 → skip(graceful degradation,
 * 与 ttydrive-e2e 同姿态)。
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

/** 跑一次长流式会话,返回 {scrollback, screen} 两段可见文本。 */
async function driveLongStream(): Promise<{ scrollback: string; screen: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-ghost-e2e-'));
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
          FORGEAX_E2E_STREAM_DELAY_MS: '60', // 40 行 × 60ms ≈ 2.4s,跨 ~12 个节流帧
        },
        history: 2000, // pyte.HistoryScreen scrollback 档(残影证据在这)
        boot_ms: 2500,
        // 发一条消息触发流式;然后 pump 足够久让 40 行流完 + assistant 收口 + Static 提交。
        steps: [
          { send: 'go', then_ms: 400 },
          { send: '<CR>', then_ms: 6000 },
        ],
        settle_ms: 1500,
      }),
    );
    // 24 行矮终端:流式文本(40 行)必然超视口 —— 残影(若存在)必然累积。
    const proc = Bun.spawn([python!, TTYDRIVE, '24', '100', stepFile], {
      cwd: CORE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const sb = out.match(/==== SCROLLBACK[^\n]*\n([\s\S]*?)\n==== END SCROLLBACK ====/);
    const sc = out.match(/==== SCREEN[^\n]*\n([\s\S]*?)\n==== END ====/);
    return { scrollback: sb ? sb[1]! : '', screen: sc ? sc[1]! : out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 统计每条 marker(GHOST-LINE-NN)在文本中的出现次数。 */
function markerCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/GHOST-LINE-\d{2}/g)) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return counts;
}

describe.skipIf(!hasPyte)('TUI streaming ghost e2e (scrollback under a real PTY)', () => {
  test(
    'over-viewport streaming leaves no ghost copies in scrollback (each marker exactly once)',
    async () => {
      const { scrollback, screen } = await driveLongStream();
      const counts = markerCounts(scrollback + '\n' + screen);

      // turn 完整走完:40 条 marker 全部可见(durable 条目经 Static 发射)。
      expect(counts.size).toBe(40);

      // 反残影主断言:任何 marker 都不该出现第二次(残影 = 同一行的多份旧帧拷贝)。
      const dupes = [...counts.entries()].filter(([, n]) => n > 1);
      expect(dupes).toEqual([]);
    },
    30_000,
  );
});
