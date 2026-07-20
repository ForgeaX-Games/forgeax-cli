/**
 * F2 e2e 专用入口 —— 用一个「流式吐 thinking」的 fake provider 起真 TUI。
 *
 * demo provider 不发 thinking,故 F2(在飞流式 thinking → 轮末折叠)需注入本 provider。
 * runCli(argv, providerOverride) 会把它透传给 TUI driver(见 tui/app.ts runTui)。
 * 刻意在 thinking delta 之间加 sleep,让 pyte 能抓到「在飞」的那一帧。
 *
 * 仅供 tui-e2e-F2-thinking.py 经 pty 驱动;非 *.test.ts,不进 `bun test`。
 */
import { runCli } from '../../src/cli/main';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';

const CHUNKS = ['THINK-alpha ', 'THINK-beta ', 'THINK-gamma ', 'THINK-delta'];

function thinkingProvider(): LLMProvider {
  return {
    api: 'fake-thinking',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'message_start', usage: { inputTokens: 5 } };
      yield { type: 'content_block_start', index: 0, blockType: 'thinking' };
      for (const c of CHUNKS) {
        // 真实 provider 的 thinking 增量形状:delta.type==='thinking_delta'(见 provider/anthropic.ts)。
        yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: c } };
        await new Promise((r) => setTimeout(r, 500)); // 放慢:留出「在飞」帧给 pyte 抓
      }
      yield { type: 'content_block_stop', index: 0, block: {} };
      await new Promise((r) => setTimeout(r, 300));
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: CHUNKS.join('') },
            { type: 'text', text: 'ANSWER-DONE' },
          ],
        },
        usage: { inputTokens: 5, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

runCli(process.argv.slice(2), thinkingProvider()).then((c) => process.exit(c));
