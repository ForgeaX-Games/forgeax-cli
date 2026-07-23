/**
 * TUI 交互 e2e —— 在**真实 PTY** 里驱动真实 forgeax-cli Ink TUI(`--demo`,免 API key),
 * 发真实按键(打字 / 回车 / ↑翻历史 / Ctrl+C),断言**渲染到终端的可见文本**。
 *
 * 这是 TUI 验证保真度最高的一层(对比 ink-testing-library 只渲染单组件、driver.test 只测
 * 契约):它过完整路径——真 raw-mode stdin → main.ts TUI 分支判定 → Ink 布局 → 屏幕。
 *
 * 机制靠 `test/tui/ttydrive.py`(Python stdlib `pty`,零三方依赖;pyte 在则升级 2D 屏幕,
 * 不在则原始字节去 ANSI——两档都能跑)。故唯一外部前置是 `python3`;缺它 → 整组 skip
 * (graceful degradation,不污染 `bun test` 绿)。
 *
 * Boundary(HOST/test 层):node: + Bun + 相对路径。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir; // …/packages/cli/test/tui
const CORE_ROOT = join(HERE, '..', '..'); // …/packages/cli
const TTYDRIVE = join(HERE, 'ttydrive.py');

const python = Bun.which('python3');
const hasPython = python != null;

interface Step {
  send?: string;
  then_ms?: number;
  resize?: { rows: number; cols: number };
}
interface DriveSpec {
  steps: Step[];
  boot_ms?: number;
  settle_ms?: number;
  history?: number;
  env?: Record<string, string>;
  cmd?: string[];
}
interface DriveCapture {
  screen: string;
  scrollback: string;
  pyte: boolean;
}

/** 跑一段脚本化 TUI 交互,返回 ttydrive 模拟出的可见屏幕与 normal-buffer scrollback。 */
async function driveCapture(spec: DriveSpec, rows = 30, cols = 100): Promise<DriveCapture> {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-ttydrive-'));
  try {
    const stepFile = join(dir, 'step.json');
    writeFileSync(
      stepFile,
      JSON.stringify({
        cmd: spec.cmd ?? ['bun', 'src/cli/main.ts', '--demo', '--no-memory'],
        // 隔离会话/记忆到临时目录;清掉 key 证明真免网络;FORGEAX_NO_TUI 必须空(否则不进 TUI)。
        // FORGEAX_SKIP_TRUST=1:跳过首启信任门(CI 逃生口;信任门自身的 PTY 覆盖见下方专项)。
        env: {
          ANTHROPIC_API_KEY: '',
          FORGEAX_NO_TUI: '',
          FORGEAX_SKIP_TRUST: '1',
          FORGEAX_SESSIONS_DIR: join(dir, 'sessions'),
          // Hermetic: model/status assertions must not read real ~/.forgeax/settings.json.
          FORGEAX_CONFIG_DIR: join(dir, 'config'),
          ...spec.env,
        },
        boot_ms: spec.boot_ms ?? 2500,
        steps: spec.steps,
        settle_ms: spec.settle_ms ?? 1200,
        history: spec.history ?? 0,
      }),
    );
    const proc = Bun.spawn([python!, TTYDRIVE, String(rows), String(cols), stepFile], {
      cwd: CORE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const screenMatch = out.match(/==== SCREEN[^\n]*\n([\s\S]*?)\n==== END ====/);
    const historyMatch = out.match(/==== SCROLLBACK[^\n]*\n([\s\S]*?)\n==== END SCROLLBACK ====/);
    return {
      screen: screenMatch ? screenMatch[1] : out,
      scrollback: historyMatch?.[1] ?? '',
      pyte: /==== SCREEN[^\n]* pyte\)/.test(out),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function drive(spec: DriveSpec, rows = 30, cols = 100): Promise<string> {
  return (await driveCapture(spec, rows, cols)).screen;
}

describe.skipIf(!hasPython)('TUI PTY e2e (real Ink TUI under a pseudo-terminal)', () => {
  test(
    'boot → type → Enter → demo reply renders; TUI chrome present (not readline fallback)',
    async () => {
      const screen = await drive({
        steps: [
          { send: 'hello world', then_ms: 700 },
          { send: '<CR>', then_ms: 2500 },
        ],
      });
      // 真 Ink TUI 起来了(readline 回退没有这条边框提示)。
      expect(screen).toContain('/help');
      // 输入被回显。
      expect(screen).toContain('hello world');
      // demo provider 回了(整条链路:raw stdin → loop → provider → 渲染)。
      expect(screen).toContain('forgeax-cli(demo) 收到: hello world');
      // 状态行带模型名 —— TUI 的 StatusLine 在跑。
      expect(screen).toContain('claude-opus-4-8');
    },
    60_000,
  );

  test(
    'bracketed multiline paste collapses while editing, then submits and renders the original text',
    async () => {
      const screen = await drive(
        {
          steps: [
            {
              // 真终端 bracketed-paste 字节流，而非直接调用组件/纯函数。
              send: '\x1b[200~PASTE-FIRST-LINE\nPASTE-SECOND-LINE\x1b[201~',
              then_ms: 700,
            },
            { send: '<CR>', then_ms: 2500 },
          ],
        },
        40,
        110,
      );

      // 用户 transcript 已从编辑态占位还原成原文。
      expect(screen).toContain('PASTE-FIRST-LINE');
      expect(screen).toContain('PASTE-SECOND-LINE');
      // demo provider 的真实回复证明送进 agent loop 的也是展开后的原文，而非占位符。
      expect(screen).toContain('forgeax-cli(demo) 收到: PASTE-FIRST-LINE');
      expect(screen).not.toContain('收到: [Pasted text #1 +2 lines]');
    },
    60_000,
  );

  test(
    'backspace edits the input buffer before submit',
    async () => {
      const screen = await drive({
        steps: [
          { send: 'abcXYZ', then_ms: 500 },
          { send: '<BS><BS><BS>', then_ms: 500 }, // 删掉 XYZ
          { send: '!', then_ms: 400 },
          { send: '<CR>', then_ms: 2500 },
        ],
      });
      // 退格生效后提交的是 "abc!",demo 回显证明编辑落到了真实输入缓冲。
      expect(screen).toContain('forgeax-cli(demo) 收到: abc!');
      // provider 实际收到的内容里不含被删的 XYZ —— tier 无关断言(raw 档会留退格前的
      // 中间帧,故不能断言屏上不出现 "abcXYZ";但 demo 绝不会"收到"未删的串)。
      expect(screen).not.toContain('收到: abcXYZ');
    },
    60_000,
  );

  test(
    '↑ recalls the previous prompt from input history',
    async () => {
      const screen = await drive({
        steps: [
          { send: 'first-msg', then_ms: 500 },
          { send: '<CR>', then_ms: 2200 }, // 提交 → 入历史
          { send: '<UP>', then_ms: 700 }, // ↑ 把上一条召回输入框
        ],
      });
      // 召回后输入框里应再次出现 first-msg(InputHistoryProvider 的 prev())。
      expect(screen).toContain('first-msg');
    },
    60_000,
  );

  test(
    'npm start resize keeps one live input frame and never commits it to normal scrollback',
    async () => {
      const longInput =
        'RESIZE-LIVE-CANARY this is a long input line before resize to make input frame occupy and wrap across rows and expose stale border ghosts';
      const capture = await driveCapture(
        {
          // Regression path for the user report: `npm start -- --demo --no-memory` must load
          // the patched Ink and survive real SIGWINCH reflow, not only direct `bun src/...`.
          cmd: [
            'sh',
            '-c',
            "i=1; while [ $i -le 40 ]; do echo NORMAL-HISTORY-CANARY-$i; i=$((i+1)); done; exec npm start -- --demo --no-memory",
          ],
          history: 500,
          steps: [
            { send: longInput, then_ms: 800 },
            { resize: { rows: 24, cols: 55 }, then_ms: 900 },
            { resize: { rows: 18, cols: 42 }, then_ms: 900 },
            { resize: { rows: 24, cols: 55 }, then_ms: 1200 },
          ],
          settle_ms: 800,
        },
        30,
        100,
      );

      const borderLines = capture.screen
        .split('\n')
        .filter(line => line.includes('╭') || line.includes('╰'));
      expect(borderLines).toHaveLength(2);
      expect(capture.screen).toContain('RESIZE-LIVE-CANARY');
      expect(capture.screen).toContain('expose stale border ghosts');
      // A stale wide frame from the pre-resize 100-column layout would leave the old border length.
      expect(capture.screen).not.toContain('──────────────────────────────────────────────────────────────────────────────────────────────────');

      // History assertions require terminal semantics; raw ANSI capture cannot distinguish redraw
      // bytes from scrollback. With pyte, ttydrive explicitly models DEC 1049 main/alternate buffers.
      if (capture.pyte) {
        // Non-vacuous canary: npm itself writes this line before the TUI enters the alternate screen,
        // proving normal-buffer history/capture is observable rather than accidentally empty.
        expect(capture.scrollback).toContain('NORMAL-HISTORY-CANARY-1');
        expect(capture.scrollback).not.toContain('RESIZE-LIVE-CANARY');
        expect(capture.scrollback).not.toContain('╭');
        expect(capture.scrollback).not.toContain('╰');
      }
    },
    60_000,
  );

  test(
    'welcome banner renders on boot (version + model + cwd via <Static>)',
    async () => {
      const screen = await drive({ steps: [] });
      // 横幅三要素:产品名+版本、模型、cwd(可能被头部截断,断言尾部)。
      expect(screen).toContain('forgeax-cli v');
      expect(screen).toContain('claude-opus-4-8');
      expect(screen).toContain('packages/cli');
    },
    60_000,
  );

  test(
    'npm start owns alternate screen from the top row',
    async () => {
      const screen = await drive({ cmd: ['npm', 'start', '--', '--demo', '--no-memory'], steps: [] });
      const bannerRow = screen.split('\n').findIndex(line => line.includes('forgeax-cli v'));
      // DEC 1049 alone is not sufficient on every terminal: some preserve the old cursor row when
      // switching buffers. The host must explicitly clear+home before Ink renders its first frame.
      expect(bannerRow).toBeGreaterThanOrEqual(0);
      expect(bannerRow).toBeLessThanOrEqual(1);
      expect(screen).toContain('packages/cli');
    },
    60_000,
  );

  test(
    'first boot in an untrusted dir shows the trust dialog (gate before assembly)',
    async () => {
      const cfg = mkdtempSync(join(tmpdir(), 'forgeax-trust-cfg-'));
      try {
        const screen = await drive({
          // 打开信任门(SKIP 置空)+ 隔离 trust 存储到临时 config 根(不碰真 ~/.forgeax)。
          env: { FORGEAX_SKIP_TRUST: '', FORGEAX_CONFIG_DIR: cfg },
          steps: [],
        });
        expect(screen).toContain('Do you trust the files in this folder?');
        expect(screen).toContain('Yes, I trust this folder');
        expect(screen).toContain('No, exit');
      } finally {
        rmSync(cfg, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    'accepting the trust dialog enters the REPL and persists (banner appears)',
    async () => {
      const cfg = mkdtempSync(join(tmpdir(), 'forgeax-trust-cfg-'));
      try {
        const screen = await drive({
          env: { FORGEAX_SKIP_TRUST: '', FORGEAX_CONFIG_DIR: cfg },
          steps: [{ send: '<CR>', then_ms: 2500 }], // Enter = 默认选中 Yes
        });
        expect(screen).toContain('forgeax-cli v'); // 已进 REPL(横幅出现)
        expect(screen).toContain('/help'); // 输入框 chrome 在
        // 接受已落盘(下次启动不再弹)。
        const persisted = JSON.parse(
          readFileSync(join(cfg, 'projects.json'), 'utf8'),
        ) as { projects: Record<string, { trusted: boolean }> };
        expect(Object.values(persisted.projects)[0]?.trusted).toBe(true);
      } finally {
        rmSync(cfg, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

// python3 缺失时留一条可见痕迹,避免「静默全 skip」被误读成通过。
test.skipIf(hasPython)('TUI PTY e2e skipped — python3 not found on PATH', () => {
  expect(hasPython).toBe(false);
});
