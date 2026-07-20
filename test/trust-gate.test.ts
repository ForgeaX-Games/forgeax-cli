/**
 * 信任门行为(src/cli/trust.ts trustGate + textTrustPrompt):
 *   - textTrustPrompt:y/yes 接受;n/空(默认 N)拒绝;fail-closed。
 *   - trustGate:非交互/FORGEAX_SKIP_TRUST/已信任 → 放行且不弹(桩计数=0);
 *     拒绝 → false 且**不落盘**(拒绝后 isTrusted 仍 false → 不装配的前提成立);
 *     接受 → true 且落盘(下次不再弹);
 *     Ink 弹窗抛异常 → 降级纯文本门,绝不放行(P0-1)。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { isTrusted, persistTrust, textTrustPrompt, trustGate } from '../src/cli/trust';

let configDir: string;
let work: string;
let prevEnv: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'fxc-gate-cfg-'));
  work = mkdtempSync(join(tmpdir(), 'fxc-gate-work-'));
  prevEnv = process.env.FORGEAX_CONFIG_DIR;
  process.env.FORGEAX_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.FORGEAX_CONFIG_DIR;
  else process.env.FORGEAX_CONFIG_DIR = prevEnv;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

/** 注入假 io 跑 textTrustPrompt:answer 预写进 input 流。 */
async function promptWith(answer: string): Promise<{ ok: boolean; out: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c: Buffer) => (out += c.toString()));
  input.write(`${answer}\n`);
  const ok = await textTrustPrompt(work, { input, output });
  return { ok, out };
}

describe('textTrustPrompt (readline y/N fallback gate)', () => {
  test("'y' accepts", async () => {
    expect((await promptWith('y')).ok).toBe(true);
  });
  test("'YES' accepts (case-insensitive)", async () => {
    expect((await promptWith('YES')).ok).toBe(true);
  });
  test("'n' rejects", async () => {
    expect((await promptWith('n')).ok).toBe(false);
  });
  test('empty answer rejects (default N, fail-closed)', async () => {
    expect((await promptWith('')).ok).toBe(false);
  });
  test('prompt prints title + cwd + body copy', async () => {
    const { out } = await promptWith('n');
    expect(out).toContain('Do you trust');
    expect(out).toContain('[y/N]');
  });
});

describe('trustGate', () => {
  test('non-interactive → pass without prompting (cc -p semantics)', async () => {
    let calls = 0;
    const ok = await trustGate({
      cwd: work,
      interactive: false,
      wantTui: false,
      prompt: async () => ((calls++), true),
      env: {},
    });
    expect(ok).toBe(true);
    expect(calls).toBe(0);
    expect(isTrusted(work)).toBe(false); // 跳过 ≠ 信任落盘
  });

  test('FORGEAX_SKIP_TRUST=1 → pass without prompting (escape hatch)', async () => {
    let calls = 0;
    const ok = await trustGate({
      cwd: work,
      interactive: true,
      wantTui: false,
      prompt: async () => ((calls++), true),
      env: { FORGEAX_SKIP_TRUST: '1' },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(0);
  });

  test('already trusted (incl. via ancestor) → pass without prompting', async () => {
    persistTrust(work);
    const sub = join(work, 'sub');
    mkdirSync(sub, { recursive: true });
    let calls = 0;
    const ok = await trustGate({
      cwd: sub,
      interactive: true,
      wantTui: true,
      dialog: async () => ((calls++), true),
      env: {},
    });
    expect(ok).toBe(true);
    expect(calls).toBe(0);
  });

  test('reject → false and NOT persisted (caller exits before any assembly)', async () => {
    const ok = await trustGate({
      cwd: work,
      interactive: true,
      wantTui: false,
      prompt: async () => false,
      env: {},
    });
    expect(ok).toBe(false);
    expect(isTrusted(work)).toBe(false); // Esc/拒绝不落盘
  });

  test('accept → true and persisted (no re-prompt on next run)', async () => {
    let calls = 0;
    const ok = await trustGate({
      cwd: work,
      interactive: true,
      wantTui: false,
      prompt: async () => ((calls++), true),
      env: {},
    });
    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect(isTrusted(work)).toBe(true);
    // 第二次进程:已信任 → 不再弹。
    const again = await trustGate({
      cwd: work,
      interactive: true,
      wantTui: false,
      prompt: async () => ((calls++), true),
      env: {},
    });
    expect(again).toBe(true);
    expect(calls).toBe(1);
  });

  test('TUI dialog throws → degrade to text prompt, never fail-open (P0-1)', async () => {
    let promptCalls = 0;
    const rejected = await trustGate({
      cwd: work,
      interactive: true,
      wantTui: true,
      dialog: async () => {
        throw new Error('ink exploded');
      },
      prompt: async () => ((promptCalls++), false),
      env: {},
    });
    expect(rejected).toBe(false); // 弹窗崩 ≠ 放行
    expect(promptCalls).toBe(1);
    expect(isTrusted(work)).toBe(false);
  });

  test('TUI dialog accepts → persisted', async () => {
    const ok = await trustGate({
      cwd: work,
      interactive: true,
      wantTui: true,
      dialog: async () => true,
      env: {},
    });
    expect(ok).toBe(true);
    expect(isTrusted(work)).toBe(true);
  });
});
