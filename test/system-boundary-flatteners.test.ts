/**
 * Regression (P2) — 跨仓契约:`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 哨兵永不外泄给模型。
 *
 * 装配器在 `globalCacheEnabled` 时会插一个 `{ text: SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
 * boundary: true }` 分界块(static/dynamic cache 边界)。它是**内部实现细节**,四个
 * provider flattener 拍平 SystemBlock[] 成 wire system prompt 时必须一律 `filter(b=>!b.boundary)`
 * 剔除。曾经 `openai-response.ts` 的 `systemBlocksToInstructions` 漏了这层 filter,走
 * OpenAI Responses backend + global cache 时哨兵串原样发给模型。
 *
 * 本测试把四个 flattener 一起钉住,防再次漂移。
 *
 * Boundary: test 层。
 */
import { test, expect, describe } from 'bun:test';
import { systemBlocksToAnthropic } from '../src/provider/anthropic';
import { systemBlocksToText } from '../src/provider/openai-compat';
import { systemBlocksToGemini } from '../src/provider/gemini';
import { systemBlocksToInstructions } from '../src/provider/openai-response';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY as B } from '../src/context/types';
import type { SystemBlock } from '../src/provider/types';

const blocks: SystemBlock[] = [
  { type: 'text', text: 'STATIC-PROMPT', cacheScope: 'global' },
  { type: 'text', text: B, cacheScope: null, boundary: true },
  { type: 'text', text: 'DYNAMIC-PROMPT', cacheScope: null },
];

describe('SYSTEM_PROMPT_DYNAMIC_BOUNDARY 哨兵不外泄 (四 flattener 契约)', () => {
  test('anthropic: system 块不含哨兵', () => {
    expect(JSON.stringify(systemBlocksToAnthropic(blocks))).not.toContain(B);
  });

  test('openai-compat (text): instructions 不含哨兵', () => {
    expect(systemBlocksToText(blocks)).not.toContain(B);
  });

  test('gemini: systemInstruction 不含哨兵', () => {
    expect(JSON.stringify(systemBlocksToGemini(blocks) ?? '')).not.toContain(B);
  });

  test('openai-response (instructions): 不含哨兵(曾泄漏)', () => {
    expect(systemBlocksToInstructions(blocks) ?? '').not.toContain(B);
  });

  test('四者仍保留真实静态/动态内容(只剔哨兵,不误伤)', () => {
    const out = systemBlocksToInstructions(blocks) ?? '';
    expect(out).toContain('STATIC-PROMPT');
    expect(out).toContain('DYNAMIC-PROMPT');
  });
});
