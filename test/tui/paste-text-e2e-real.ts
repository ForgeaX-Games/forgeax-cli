/**
 * 多行文本粘贴真实 E2E —— 真 PTY + 真 Ink TUI + 真 Anthropic API。
 *
 * 验证完整链路:bracketed-paste 字节 → 编辑态折叠 → Enter 提交 → transcript 展开 →
 * provider 收到原文并回复。不是 *.test.ts，避免进入离线 `bun test`；手动/CI 显式运行:
 *   bun run e2e:tui-paste
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir;
const CORE_ROOT = join(HERE, '..', '..');
const MAIN = join(CORE_ROOT, 'src', 'cli', 'main.ts');
const TTYDRIVE = join(HERE, 'ttydrive.py');
const KEY = process.env.ANTHROPIC_API_KEY;
const python = Bun.which('python3');

if (!KEY) {
  console.error('需要 ANTHROPIC_API_KEY。');
  process.exit(2);
}
if (!python) {
  console.error('需要 python3(ttydrive.py 驱动真实 PTY)。');
  process.exit(2);
}

const LINE_ONE = 'REAL-PASTE-LINE-ONE';
const LINE_TWO = 'REAL-PASTE-LINE-TWO';
const REPLY = 'TUI-PASTE-REAL-OK';
const PLACEHOLDER = '[Pasted text #1 +2 lines]';

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'paste-text-e2e-'));
  const sessionsDir = join(dir, 'sessions');
  try {
    const spec = {
      cmd: ['bun', MAIN, '--no-memory'],
      env: {
        ANTHROPIC_API_KEY: KEY,
        ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
        ...(process.env.FORGEAX_MODEL ? { FORGEAX_MODEL: process.env.FORGEAX_MODEL } : {}),
        FORGEAX_NO_TUI: '',
        FORGEAX_SKIP_TRUST: '1',
        FORGEAX_SESSIONS_DIR: sessionsDir,
        FORGEAX_CONFIG_DIR: join(dir, 'config'),
      },
      boot_ms: 3000,
      steps: [
        {
          // 先键入指令但不提交；随后发送真实 bracketed-paste 控制字节，整段一次 Enter 入轮。
          send: `Reply with exactly ${REPLY} after reading both pasted lines: `,
          then_ms: 500,
        },
        {
          send: `[200~${LINE_ONE}\n${LINE_TWO}[201~`,
          then_ms: 700,
        },
        { send: '<CR>', then_ms: 20_000 },
      ],
      settle_ms: 2000,
    };
    const stepFile = join(dir, 'step.json');
    writeFileSync(stepFile, JSON.stringify(spec));

    console.log(`[paste-text-e2e] cwd=${CORE_ROOT} model=${process.env.FORGEAX_MODEL ?? 'default'}`);
    const proc = Bun.spawn([python!, TTYDRIVE, '40', '120', stepFile], {
      cwd: CORE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = stdout + stderr;
    const match = output.match(/==== SCREEN[^\n]*\n([\s\S]*?)\n==== END ====/);
    const screen = match?.[1] ?? output;

    let wal = '';
    for (const sid of readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      try {
        wal += readFileSync(join(sessionsDir, sid.name, 'events.jsonl'), 'utf8');
      } catch {
        // Ignore a session directory without a completed WAL file.
      }
    }

    const checks: Array<[string, boolean]> = [
      ['PTY driver 正常退出', exitCode === 0],
      ['transcript 显示粘贴第一行原文', screen.includes(LINE_ONE)],
      ['transcript 显示粘贴第二行原文', screen.includes(LINE_TWO)],
      ['模型按要求回复，证明真实 API 完成该轮', screen.includes(REPLY)],
      ['WAL prompt 包含粘贴第一行原文', wal.includes(LINE_ONE)],
      ['WAL prompt 包含粘贴第二行原文', wal.includes(LINE_TWO)],
      ['WAL prompt 不包含编辑态占位符', !wal.includes(PLACEHOLDER)],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (checks.some(([, ok]) => !ok)) {
      console.error('\n--- terminal screen ---\n' + screen);
      return 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(await main());
