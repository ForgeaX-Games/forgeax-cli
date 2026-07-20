/**
 * E-03 — OS 级沙箱 TerminalManager。
 *
 * ① hermetic(跨平台):平台→种类映射、状态解析、profile/argv 构造、装饰器改写、loud 降级。
 * ② macOS 真 e2e(仅 darwin 跑):对比**裸 NodeTerminal**(无隔离,能写 cwd 外 = 红)与
 *    **SandboxedTerminal**(cwd 外写被 OS 层拒 = 绿),并验证 cwd 内 .git 受保护子路径只读。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  detectSandboxKind,
  resolveSandboxStatus,
  buildSeatbeltProfile,
  wrapSeatbelt,
  wrapBwrap,
  SandboxedTerminal,
  withSandbox,
} from '../src/cli/sandbox-terminal';
import { NodeTerminal } from '../src/cli/io';
import type { TerminalManager, RunOpts, RunResult, TaskHandle, Chunk } from '../src/inject/types';

// 记录调用的假内层 terminal(验证装饰器把 cmd 改写成沙箱调用)。
class RecordingTerminal implements TerminalManager {
  calls: Array<{ cmd: string; args: string[] }> = [];
  async run(cmd: string, args: string[]): Promise<RunResult> {
    this.calls.push({ cmd, args });
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
  }
  async *stream(cmd: string, args: string[]): AsyncIterable<Chunk> {
    this.calls.push({ cmd, args });
    yield { stream: 'exit', data: '0' };
  }
  async runBackground(cmd: string, args: string[]): Promise<TaskHandle> {
    this.calls.push({ cmd, args });
    return { id: 't', agentId: 'a', cmd, startedAt: 0 };
  }
  list(): TaskHandle[] { return []; }
  async kill(): Promise<void> {}
  async killAll(): Promise<void> {}
  _unused(_o?: RunOpts): void {}
}

describe('E-03 sandbox — hermetic', () => {
  test('平台 → 沙箱种类', () => {
    expect(detectSandboxKind('darwin')).toBe('seatbelt');
    expect(detectSandboxKind('linux')).toBe('bwrap');
    expect(detectSandboxKind('win32')).toBe('none');
  });

  test('resolveSandboxStatus:不支持平台(win32)要求开启 → 不生效 + loud 理由', () => {
    const s = resolveSandboxStatus(true, 'win32');
    expect(s.kind).toBe('none');
    expect(s.available).toBe(false);
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain('WITHOUT OS isolation');
  });

  test('Seatbelt profile 放行 cwd、收回 .git/.forgeax', () => {
    const prof = buildSeatbeltProfile('/Users/you/proj');
    expect(prof).toContain('(allow default)');
    expect(prof).toContain('(deny file-write*)');
    expect(prof).toContain('proj'); // cwd 可写
    expect(prof).toContain('.git'); // 受保护子路径收回只读
    expect(prof).toContain('.forgeax');
  });

  test('wrap 构造:seatbelt=sandbox-exec -p …,bwrap=bwrap … -- cmd', () => {
    const [sc, sa] = wrapSeatbelt('sh', ['-c', 'echo hi'], '/Users/you/proj');
    expect(sc).toBe('sandbox-exec');
    expect(sa[0]).toBe('-p');
    expect(sa.slice(-3)).toEqual(['sh', '-c', 'echo hi']);

    const [bc, ba] = wrapBwrap('sh', ['-c', 'echo hi'], '/home/you/proj');
    expect(bc).toBe('bwrap');
    expect(ba).toContain('--ro-bind');
    expect(ba.slice(-3)).toEqual(['sh', '-c', 'echo hi']);
  });

  test('SandboxedTerminal 装饰器:run 把 cmd 改写成沙箱调用后委托内层', async () => {
    const inner = new RecordingTerminal();
    const sandboxed = new SandboxedTerminal(inner, 'seatbelt', '/Users/you/proj');
    await sandboxed.run('sh', ['-c', 'echo hi']);
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0].cmd).toBe('sandbox-exec');
    expect(inner.calls[0].args.slice(-3)).toEqual(['sh', '-c', 'echo hi']);
  });

  test('withSandbox:未要求 → 原样内层(不套沙箱)', () => {
    const inner = new RecordingTerminal();
    const { terminal, status } = withSandbox(inner, false);
    expect(terminal).toBe(inner);
    expect(status.enabled).toBe(false);
  });
});

// ── macOS 真 e2e:红(裸终端能越界写)vs 绿(沙箱越界写被 OS 拒)──────────────
const isMac = process.platform === 'darwin';
describe.if(isMac)('E-03 sandbox — macOS Seatbelt real e2e', () => {
  test('裸 NodeTerminal(红):cwd 外写成功 = 无 OS 隔离', async () => {
    const cwd = mkdtempSync(join(homedir(), '.forgeax-e2e-'));
    const external = join(homedir(), `.forgeax-escape-${process.pid}-red.txt`);
    try {
      const term = new NodeTerminal();
      const r = await term.run('sh', ['-c', `echo pwned > ${external}`], { cwd });
      expect(r.exitCode).toBe(0);
      expect(existsSync(external)).toBe(true); // 越界写成功 → 这正是 E-03 要堵的洞
    } finally {
      rmSync(external, { force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('SandboxedTerminal(绿):cwd 内可写、cwd 外被 OS 拒、.git 只读', async () => {
    const cwd = mkdtempSync(join(homedir(), '.forgeax-e2e-'));
    mkdirSync(join(cwd, '.git'));
    const external = join(homedir(), `.forgeax-escape-${process.pid}-green.txt`);
    const inside = join(cwd, 'inside.txt');
    const gitFile = join(cwd, '.git', 'hijack');
    try {
      const term = new SandboxedTerminal(new NodeTerminal(), 'seatbelt', cwd);

      // cwd 内写:放行。
      const okIn = await term.run('sh', ['-c', `echo ok > ${inside}`], { cwd });
      expect(okIn.exitCode).toBe(0);
      expect(existsSync(inside)).toBe(true);

      // cwd 外写:OS 层拒(exit≠0 且文件不存在)。
      const blocked = await term.run('sh', ['-c', `echo pwned > ${external}`], { cwd });
      expect(blocked.exitCode).not.toBe(0);
      expect(existsSync(external)).toBe(false);

      // cwd 内 .git 受保护子路径:只读,写被拒。
      const gitBlocked = await term.run('sh', ['-c', `echo x > ${gitFile}`], { cwd });
      expect(gitBlocked.exitCode).not.toBe(0);
      expect(existsSync(gitFile)).toBe(false);
    } finally {
      rmSync(external, { force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
