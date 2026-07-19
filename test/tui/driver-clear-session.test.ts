/**
 * F1 回归证据 —— /clear 语义 = 「开一条新会话」(对齐 cc)。
 *
 * 断言 driver.clearHistory():
 *   ① 对旧会话经 host.bus 发一条 SessionEnd(reason='clear')→ 用户 SessionEnd hook 会被触发;
 *   ② 换新 sessionId(getter 反映新身份,且非旧值);
 *   ③ 清累计计费 usageAcc(getUsage 归零,连带解 D6)。
 */
import { test, expect, describe } from 'bun:test';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { CoreEventType } from '../../src/events/events';

function replyProvider(): LLMProvider {
  return {
    api: 'fake',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

describe('F1 /clear = 新会话', () => {
  test('clearHistory:发 SessionEnd(clear) + 换 sessionId + 清成本', async () => {
    const provider = replyProvider();
    const host = await buildHostContext({ model: 'claude-opus-4-8' }, provider);
    // 订阅 host.bus 上的 SessionEnd,捕获 driver 在 /clear 时补发的那一条(source='tui-clear')。
    const sessionEnds: Array<{ sessionId?: string; reason?: string; source?: string }> = [];
    host.bus.subscribe(CoreEventType.SessionEnd, (ev) => {
      const p = ev.payload as { sessionId?: string; reason?: string };
      sessionEnds.push({ ...p, source: ev.source });
    });

    const driver = createAgentDriver(
      { model: 'claude-opus-4-8', sessionId: 'sess-1', providerOverride: provider },
      host,
    );

    // 跑一轮攒点成本 + 确认起始身份。
    expect(driver.sessionId).toBe('sess-1');
    await driver.driveTurn('hi', () => {});
    expect(driver.getUsage().inputTokens).toBeGreaterThan(0);

    driver.clearHistory();

    // ① /clear 补发的 SessionEnd:reason='clear'、source='tui-clear'、指向旧会话 id。
    const clearEnd = sessionEnds.find((e) => e.source === 'tui-clear');
    expect(clearEnd).toBeDefined();
    expect(clearEnd!.reason).toBe('clear');
    expect(clearEnd!.sessionId).toBe('sess-1');

    // ② 换新 sessionId:非旧值、非空。
    expect(driver.sessionId).not.toBe('sess-1');
    expect(driver.sessionId && driver.sessionId.length).toBeGreaterThan(0);

    // ③ 成本归零。
    expect(driver.getUsage().inputTokens).toBe(0);
    expect(driver.getUsage().outputTokens).toBe(0);

    await driver.dispose();
  });
});
