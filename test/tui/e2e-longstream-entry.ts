/**
 * 残影 e2e 专用入口 —— 用一个「慢速流式吐 40 条 marker 行」的 fake provider 起真 TUI。
 *
 * 复现 2026-07-13 报告的动态区超视口残影:在写 streamingText 高过终端 → Ink 每帧擦不净
 * 溢出行 → scrollback 每个节流帧积一份重复。marker 行(GHOST-LINE-NN)可数,配合
 * ttydrive.py 的 history 档(pyte.HistoryScreen)断言「scrollback + 视口里每条 marker
 * 恰出现一次」。节奏:每行一个 text_delta,间隔 FORGEAX_E2E_STREAM_DELAY_MS(默认 60)
 * → 全程 ~2.4s,跨 ~12 个 200ms 节流帧,残影(若存在)必然累积。
 *
 * 仅供 ttydrive-ghost-e2e.test.ts 经 pty 驱动;非 *.test.ts,不进 `bun test`。
 */
import { runCli } from '../../src/cli/main';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../../src/provider/types';
import { EMPTY_USAGE } from '../../src/provider/types';

export const GHOST_LINES = 40;
const line = (i: number): string => `GHOST-LINE-${String(i).padStart(2, '0')} lorem ipsum filler`;

function longStreamProvider(): LLMProvider {
  const delayMs = Number(process.env.FORGEAX_E2E_STREAM_DELAY_MS ?? '60') || 60;
  return {
    api: 'fake-longstream',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      const full = Array.from({ length: GHOST_LINES }, (_, i) => line(i)).join('\n');
      yield { type: 'message_start', usage: EMPTY_USAGE as Usage };
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      for (let i = 0; i < GHOST_LINES; i++) {
        const piece = (i > 0 ? '\n' : '') + line(i);
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } };
        await new Promise((r) => setTimeout(r, delayMs));
      }
      yield { type: 'content_block_stop', index: 0, block: { type: 'text', text: full } };
      yield { type: 'message_delta', usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: full }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

runCli(process.argv.slice(2), longStreamProvider()).then((c) => process.exit(c));
