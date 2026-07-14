/** 046 楔子3:hook 脚本(kernel-permission-hook.mjs / cursor-permission-hook.mjs)
 *  契约集成测试 —— 真 spawn 脚本(bun 跑 .mjs),stdin 喂内核 PreToolUse/hook payload,
 *  stub hook-gate HTTP server 回放决策,断言 stdout 形状。
 *
 *  钉住的契约(2026-07-14 对三内核实测过的形状):
 *   - cc/codex:stdout `hookSpecificOutput.permissionDecision` allow/deny;none/无上下文
 *     → 零输出(不干预);mcp__fxt__* 跳过;plan 模式不发 allow;传输错误 fail-closed deny。
 *   - cursor:stdout `{permission}`;灾难性命令本地硬 deny(不回调);none → allow
 *     (--force 基线);无上下文 → 零输出。 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const KERNEL_HOOK = resolve(import.meta.dirname, '../src/kernel/hooks/kernel-permission-hook.mjs');
const CURSOR_HOOK = resolve(import.meta.dirname, '../src/kernel/hooks/cursor-permission-hook.mjs');

let server: ReturnType<typeof Bun.serve>;
let port: number;
/** 按 toolName 定制的 stub 决策表(默认 none)。 */
const canned: Record<string, { decision: string; reason?: string }> = {
  DenyMe: { decision: 'deny', reason: 'denied by rule test "DenyMe"' },
  AllowMe: { decision: 'allow', reason: 'allow by rule' },
};
const received: Array<{ sid: string; body: any }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const m = new URL(req.url).pathname.match(/^\/api\/sessions\/([^/]+)\/hook-gate$/);
      if (!m) return new Response('nf', { status: 404 });
      const body = await req.json();
      received.push({ sid: decodeURIComponent(m[1]), body });
      const hit = canned[body.toolName] ?? { decision: 'none' };
      return Response.json(hit);
    },
  });
  port = server.port;
});

afterAll(() => {
  server.stop(true);
});

interface HookRun {
  stdout: string;
  exitCode: number;
}

async function runHook(script: string, stdinObj: unknown, opts: { argv?: string[]; env?: Record<string, string> }): Promise<HookRun> {
  const proc = Bun.spawn([process.execPath, script, ...(opts.argv ?? [])], {
    stdin: new TextEncoder().encode(JSON.stringify(stdinObj)),
    stdout: 'pipe',
    stderr: 'pipe',
    // 基线 env 清掉 FORGEAX_*(封闭),再叠加 case 自己的。
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(opts.env ?? {}) },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

const ctxEnv = () => ({
  FORGEAX_SERVER_URL: `http://127.0.0.1:${port}`,
  FORGEAX_SID: 'sid-1',
  FORGEAX_AGENT: 'forge',
  FORGEAX_KERNEL: 'codex',
});

describe('kernel-permission-hook.mjs(cc/codex)', () => {
  test('无 forgeax 上下文 → 零输出零干预(用户自跑内核)', async () => {
    const r = await runHook(KERNEL_HOOK, { tool_name: 'Bash', tool_input: { command: 'x' } }, {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('deny → permissionDecision deny + reason;POST 形状正确', async () => {
    received.length = 0;
    const r = await runHook(KERNEL_HOOK, { tool_name: 'DenyMe', tool_input: { command: 'rm -rf /x' } }, { env: ctxEnv() });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('DenyMe');
    expect(received[0].sid).toBe('sid-1');
    expect(received[0].body).toMatchObject({ kernel: 'codex', agent: 'forge', toolName: 'DenyMe', input: { command: 'rm -rf /x' } });
  });

  test('allow → permissionDecision allow;plan 模式下不发 allow(零输出)', async () => {
    const r1 = await runHook(KERNEL_HOOK, { tool_name: 'AllowMe', tool_input: {} }, { env: ctxEnv() });
    expect(JSON.parse(r1.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
    const r2 = await runHook(KERNEL_HOOK, { tool_name: 'AllowMe', tool_input: {}, permission_mode: 'plan' }, { env: ctxEnv() });
    expect(r2.stdout).toBe('');
  });

  test('none → 零输出(内核默认权限流);mcp__fxt__* 跳过不回调', async () => {
    const r1 = await runHook(KERNEL_HOOK, { tool_name: 'Bash', tool_input: { command: 'ls' } }, { env: ctxEnv() });
    expect(r1.stdout).toBe('');
    received.length = 0;
    const r2 = await runHook(KERNEL_HOOK, { tool_name: 'mcp__fxt__write_file', tool_input: {} }, { env: ctxEnv() });
    expect(r2.stdout).toBe('');
    expect(received).toHaveLength(0);
  });

  test('argv 上下文优先(cc per-turn settings 传参)+ 传输错误 fail-closed deny', async () => {
    received.length = 0;
    const r1 = await runHook(KERNEL_HOOK, { tool_name: 'DenyMe', tool_input: {} }, { argv: [String(port), 'sid-argv', 'iori', 'claude-code'] });
    expect(JSON.parse(r1.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(received[0].sid).toBe('sid-argv');
    expect(received[0].body.kernel).toBe('claude-code');
    // 端口不通 → deny(fail-closed)。
    const r2 = await runHook(KERNEL_HOOK, { tool_name: 'Bash', tool_input: {} }, { argv: ['1', 'sid-x', 'forge', 'claude-code'] });
    const out = JSON.parse(r2.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('fail-closed');
  });
});

describe('cursor-permission-hook.mjs', () => {
  const cursorEnv = () => ({ FORGEAX_SERVER_URL: `http://127.0.0.1:${port}`, FORGEAX_SID: 'sid-c', FORGEAX_AGENT: 'forge' });

  test('无 forgeax 上下文 → 零输出零干预', async () => {
    const r = await runHook(CURSOR_HOOK, { hook_event_name: 'beforeShellExecution', command: 'ls' }, {});
    expect(r.stdout).toBe('');
  });

  test('灾难性命令 → 本地硬 deny(不回调 server)', async () => {
    received.length = 0;
    const r = await runHook(CURSOR_HOOK, { hook_event_name: 'beforeShellExecution', command: 'rm -rf / ' }, { env: cursorEnv() });
    expect(JSON.parse(r.stdout).permission).toBe('deny');
    expect(received).toHaveLength(0);
    // 具体路径不算灾难性 → 回调 server(none → allow)。
    const r2 = await runHook(CURSOR_HOOK, { hook_event_name: 'beforeShellExecution', command: 'rm -rf /tmp/specific' }, { env: cursorEnv() });
    expect(JSON.parse(r2.stdout).permission).toBe('allow');
    expect(received).toHaveLength(1);
  });

  test('shell:deny 规则 → deny;none → allow(--force 基线);POST 形状 toolName=Bash', async () => {
    received.length = 0;
    const r1 = await runHook(CURSOR_HOOK, { hook_event_name: 'beforeShellExecution', command: 'x' , tool_input: undefined, session_id: 'ignored' }, { env: cursorEnv() });
    expect(JSON.parse(r1.stdout).permission).toBe('allow');
    expect(received[0].body.toolName).toBe('Bash');
    expect(received[0].body.input.command).toBe('x');
    // MCP 事件带 tool_name;fxt 直放不回调。
    received.length = 0;
    const r2 = await runHook(CURSOR_HOOK, { hook_event_name: 'beforeMCPExecution', tool_name: 'mcp__fxt__query_world', tool_input: {} }, { env: cursorEnv() });
    expect(JSON.parse(r2.stdout).permission).toBe('allow');
    expect(received).toHaveLength(0);
    const r3 = await runHook(CURSOR_HOOK, { hook_event_name: 'beforeMCPExecution', tool_name: 'DenyMe', tool_input: {} }, { env: cursorEnv() });
    expect(JSON.parse(r3.stdout).permission).toBe('deny');
  });

  test('传输错误 → fail-closed deny', async () => {
    const r = await runHook(CURSOR_HOOK, { hook_event_name: 'beforeShellExecution', command: 'ls' }, { env: { FORGEAX_SERVER_URL: 'http://127.0.0.1:1', FORGEAX_SID: 's' } });
    const out = JSON.parse(r.stdout);
    expect(out.permission).toBe('deny');
    expect(out.agent_message).toContain('fail-closed');
  });
});
