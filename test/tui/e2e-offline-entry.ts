/**
 * F3 e2e 专用入口 —— 用一个「stream 直接抛错」的 fake provider 起真 TUI,忠实模拟离线
 * (离线时 provider.stream 的 fetch 会 reject,等价于抛错)。
 *
 * 配合 FORGEAX_INIT_TIMEOUT_MS 短时限,验证 /init 在离线下**有界降级、不卡死、不假成功**。
 * 仅供 tui-e2e-F3-init.py 经 pty 驱动;非 *.test.ts,不进 `bun test`。
 */
import { runCli } from '../../src/cli/main';
import type { LLMProvider, ProviderStreamEvent } from '../../src/provider/types';

function offlineProvider(): LLMProvider {
  return {
    api: 'fake-offline',
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      throw new Error('ENOTFOUND api.anthropic.com (simulated offline)');
    },
  };
}

runCli(process.argv.slice(2), offlineProvider()).then((c) => process.exit(c));
