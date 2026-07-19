/**
 * F3 回归证据 —— /init 离线 / 挂起兜底(driver.runInit 绝不卡死、绝不抛,回可读降级)。
 *
 * 关键实证(见 driver.runInit 注释):离线时供应商抛错会触发 stream-retry 的**持续重试**
 * (实测跑满 120s 才停)——正是 F3「会卡住」的病灶。故两种失败模式都靠超时闸兜底(经
 * FORGEAX_INIT_TIMEOUT_MS 注入短时限),都在有界时间内回 {ok:false},UI 不卡死、不假成功:
 *   - 供应商挂起(永不返回)→ 超时 → reason='timeout';
 *   - 供应商持续抛错(模拟离线 fetch 失败 + 重试风暴)→ 超时 → 有界 ok:false。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import type { LLMProvider, ProviderStreamEvent } from '../../src/provider/types';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';

function throwingProvider(): LLMProvider {
  return {
    api: 'fake',
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      throw new Error('ENOTFOUND api.anthropic.com'); // 模拟离线:DNS/连接失败
    },
  };
}

function hangingProvider(): LLMProvider {
  return {
    api: 'fake',
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      await new Promise<never>(() => {}); // 永不返回:模拟代理挂起(下方永不可达)
    },
  };
}

afterEach(() => {
  delete process.env.FORGEAX_INIT_TIMEOUT_MS;
});

describe('F3 /init 降级兜底', () => {
  test('离线(供应商持续抛错 + 重试风暴)→ 有界 ok:false,不卡死、不假成功', async () => {
    process.env.FORGEAX_INIT_TIMEOUT_MS = '120'; // 注入短时限:否则重试风暴要跑满默认 120s
    const provider = throwingProvider();
    const host = await buildHostContext({ model: 'claude-opus-4-8' }, provider);
    const driver = createAgentDriver({ model: 'claude-opus-4-8', providerOverride: provider }, host);

    const started = Date.now();
    const r = await driver.runInit();
    expect(Date.now() - started).toBeLessThan(5_000); // 有界返回,绝不卡死 UI
    expect(r.ok).toBe(false); // 绝不假报成功
    if (!r.ok) expect(['timeout', 'error']).toContain(r.reason);

    await driver.dispose();
  });

  test('挂起(供应商永不返回)→ 超时闸 → ok:false / reason=timeout,不卡死', async () => {
    process.env.FORGEAX_INIT_TIMEOUT_MS = '80'; // 注入短时限,避免测试等 120s
    const provider = hangingProvider();
    const host = await buildHostContext({ model: 'claude-opus-4-8' }, provider);
    const driver = createAgentDriver({ model: 'claude-opus-4-8', providerOverride: provider }, host);

    const started = Date.now();
    const r = await driver.runInit();
    expect(Date.now() - started).toBeLessThan(5_000); // 确实靠超时快速返回,而非跑满
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');

    await driver.dispose();
  });
});
