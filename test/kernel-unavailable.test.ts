/**
 * kernel-unavailable —— 内核不可用的成因分类 + 友好文案 + 单一翻译点。
 *
 * 回归守卫(todo #040):
 *  - 裸 `kernel_unavailable: <id>` / spawn ENOENT 串必须翻成带成因 + 修复指引的文案。
 *  - chat 出口 catch-all 不再把「真·运行时报错」一律误标成 kernel_unavailable。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentKernel, KernelHealth } from '@forgeax/agent-runtime';
import {
  KernelUnavailableError,
  classifyProbeDetail,
  describeKernelUnavailable,
  toKernelErrorPayload,
} from '../src/kernel/kernel-unavailable';

/** Minimal AgentKernel stub whose only relevant behaviour is `probe()`. */
function stubKernel(id: string, health: KernelHealth | Error): AgentKernel {
  return {
    id: id as AgentKernel['id'],
    capabilities: {} as AgentKernel['capabilities'],
    // eslint-disable-next-line require-yield
    async *runTurn() {
      throw new Error('not used');
    },
    openHandle() {
      throw new Error('not used');
    },
    async probe() {
      if (health instanceof Error) throw health;
      return health;
    },
  } as unknown as AgentKernel;
}

describe('classifyProbeDetail — 成因从 probe detail 推断', () => {
  test('缺可执行文件 → not-installed', () => {
    expect(classifyProbeDetail('spawn cursor-agent ENOENT')).toBe('not-installed');
    expect(classifyProbeDetail('cursor-agent binary not on PATH (install: ...)')).toBe('not-installed');
    expect(classifyProbeDetail('command not found')).toBe('not-installed');
  });
  test('缺登录/凭据 → not-logged-in', () => {
    expect(classifyProbeDetail('ANTHROPIC_API_KEY/login missing')).toBe('not-logged-in');
    expect(classifyProbeDetail('OPENAI_API_KEY not set (or run codex login)')).toBe('not-logged-in');
    expect(classifyProbeDetail('codebuddy login missing (run `codebuddy`)')).toBe('not-logged-in');
  });
  test('其他 / 空 → not-ready(保守,不误判)', () => {
    expect(classifyProbeDetail('cursor-agent --version exit 3')).toBe('not-ready');
    expect(classifyProbeDetail(undefined)).toBe('not-ready');
  });
});

describe('describeKernelUnavailable — 友好文案带 id + 成因 + 修复指引', () => {
  test('not-installed 带安装指引 + 内核 id 字面量 + 官方配置文档链接', () => {
    const m = describeKernelUnavailable('cursor-agent', 'not-installed');
    expect(m).toContain('cursor-agent');
    expect(m).toContain('配置文档:');
    expect(m).toContain('https://cursor.com/docs/cli/installation'); // 官方 setup 文档
  });
  test('not-logged-in 带登录指引 + 官方配置文档链接', () => {
    const m = describeKernelUnavailable('codex', 'not-logged-in');
    expect(m).toContain('codex');
    expect(m).toContain('login');
    expect(m).toContain('https://developers.openai.com/codex/cli'); // 官方 setup 文档
  });
  test('每个第三方内核都带官方 setup 文档链接', () => {
    expect(describeKernelUnavailable('claude-code', 'not-installed')).toContain('https://code.claude.com/docs/en/setup');
    expect(describeKernelUnavailable('codebuddy', 'not-logged-in')).toContain('https://www.codebuddy.ai/docs/cli/');
  });
  test('unknown-id 带可用清单', () => {
    const m = describeKernelUnavailable('bogus', 'unknown-id', 'claude-code, codex');
    expect(m).toContain('bogus');
    expect(m).toContain('claude-code, codex');
  });
  test('not-registered 引导检查 FORGEAX_KERNEL_IMPL', () => {
    expect(describeKernelUnavailable('forgeax-core', 'not-registered')).toContain('FORGEAX_KERNEL_IMPL');
  });
});

describe('toKernelErrorPayload — 单一翻译点', () => {
  test('KernelUnavailableError → 友好 kernel_unavailable(带结构化 kernelId/reason)', async () => {
    const err = new KernelUnavailableError('cursor-agent', 'unknown-id', 'claude-code, codex');
    const p = await toKernelErrorPayload(null, err);
    expect(p.code).toBe('kernel_unavailable');
    expect(p.kernelId).toBe('cursor-agent');
    expect(p.reason).toBe('unknown-id');
    expect(p.message).toContain('cursor-agent');
  });

  test('内核 probe 判 down(缺 CLI)→ 裸 spawn 串翻成友好 kernel_unavailable', async () => {
    const kernel = stubKernel('cursor-agent', {
      ok: false,
      kernelId: 'cursor-agent',
      detail: 'cursor-agent binary not on PATH (install: https://cursor.com/cli)',
    });
    const p = await toKernelErrorPayload(kernel, { message: 'cursor-agent stream error: spawn ENOENT' }, 'protocol');
    expect(p.code).toBe('kernel_unavailable');
    expect(p.reason).toBe('not-installed');
    expect(p.message).toContain('https://cursor.com/docs/cli/installation'); // 官方 setup 文档
  });

  test('内核 probe OK → 真·运行时报错保留原样,标 turn_failed(不再误标 kernel_unavailable)', async () => {
    const kernel = stubKernel('forgeax-core', { ok: true, kernelId: 'forgeax-core', detail: 'ready' });
    const p = await toKernelErrorPayload(kernel, { message: 'upstream 500 from model gateway' }, 'protocol');
    // probe ok → 保留原 code(此处 rawCode='protocol'),绝不冒充 kernel_unavailable。
    expect(p.code).toBe('protocol');
    expect(p.message).toContain('upstream 500');
  });

  test('无 rawCode 的抛错 + probe OK → turn_failed(catch-all 不再一律 kernel_unavailable)', async () => {
    const kernel = stubKernel('forgeax-core', { ok: true, kernelId: 'forgeax-core' });
    const p = await toKernelErrorPayload(kernel, new Error('boom mid-turn'));
    expect(p.code).toBe('turn_failed');
    expect(p.message).toBe('boom mid-turn');
  });

  test('probe 自身抛错 → not-ready 友好文案(不掩盖成运行时错)', async () => {
    const kernel = stubKernel('codex', new Error('probe crashed'));
    const p = await toKernelErrorPayload(kernel, new Error('spawn failed'));
    expect(p.code).toBe('kernel_unavailable');
    expect(p.reason).toBe('not-ready');
  });
});
