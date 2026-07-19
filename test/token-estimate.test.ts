/**
 * 04.8 image token 估算(bytes-band)验收 —— 移植 agentic_os 04.8。
 *
 * 修复前:image block 的 base64 按 char/4 计,1MB 图 ≈ 333K "token"(真实 ~1.5K,
 * 偏差 100-1000x)→ 首轮水位判定 / 压后 blocking 判定被虚高值误触发。
 * 修复后:image/media block 按解码字节三档经验系数(250/1500/3000),保持高估方向。
 */
import { describe, test, expect } from 'bun:test';
import {
  estimateTokens,
  imageTokensFromBase64Length,
  IMAGE_TOKEN_SMALL,
  IMAGE_TOKEN_MEDIUM,
  IMAGE_TOKEN_LARGE,
} from '../src/context/deterministic-compact';

/** 构造指定 base64 长度的 image block(Anthropic 形)。 */
const imageBlock = (base64Len: number) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(base64Len) },
});

describe('04.8 — imageTokensFromBase64Length 三档分带', () => {
  test('raw < 50KB → SMALL(250)', () => {
    // base64 66_664 chars → raw ≈ 49_998 bytes
    expect(imageTokensFromBase64Length(66_664)).toBe(IMAGE_TOKEN_SMALL);
    expect(imageTokensFromBase64Length(100)).toBe(IMAGE_TOKEN_SMALL);
  });

  test('50KB ≤ raw < 500KB → MEDIUM(1500)', () => {
    // base64 66_668 chars → raw ≈ 50_001 bytes
    expect(imageTokensFromBase64Length(66_668)).toBe(IMAGE_TOKEN_MEDIUM);
    expect(imageTokensFromBase64Length(600_000)).toBe(IMAGE_TOKEN_MEDIUM);
  });

  test('raw ≥ 500KB → LARGE(3000)', () => {
    // base64 666_667 chars → raw ≈ 500_000 bytes
    expect(imageTokensFromBase64Length(666_667)).toBe(IMAGE_TOKEN_LARGE);
    expect(imageTokensFromBase64Length(1_400_000)).toBe(IMAGE_TOKEN_LARGE); // ~1MB raw
  });
});

describe('04.8 — estimateTokens image-aware', () => {
  test('1MB 图不再虚高 100-1000x:估算 = LARGE 带,而非 ~333K', () => {
    // 1MB raw → base64 ~1.4M chars。旧公式(JSON.stringify 全量 char/4)≈ 350K token。
    const msgs = [{ role: 'user', content: [imageBlock(1_400_000)] }];
    const est = estimateTokens(msgs);
    expect(est).toBe(IMAGE_TOKEN_LARGE);
    expect(est).toBeLessThan(10_000); // 直接钉死回归方向
  });

  test('文本 + 图混合:文本按 char/4,图按带,互不污染', () => {
    const text = 'x'.repeat(4000); // ~1000 tok
    const msgs = [{ role: 'user', content: [{ type: 'text', text }, imageBlock(1_400_000)] }];
    const est = estimateTokens(msgs);
    // 文本块 JSON 化约 4030 chars ≈ 1008 tok,加 LARGE 带。
    expect(est).toBeGreaterThan(IMAGE_TOKEN_LARGE);
    expect(est).toBeLessThan(IMAGE_TOKEN_LARGE + 1_200);
  });

  test('tool_result 嵌套图(read_file 读图形状)也走带,不按 JSON char/4', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'ok' }, imageBlock(1_400_000)],
            is_error: false,
          },
        ],
      },
    ];
    const est = estimateTokens(msgs);
    expect(est).toBeGreaterThanOrEqual(IMAGE_TOKEN_LARGE);
    expect(est).toBeLessThan(IMAGE_TOKEN_LARGE + 200);
  });

  test('已剥离的 image 占位(无 data)按结构 JSON 计(很小)', () => {
    const msgs = [{ role: 'user', content: [{ type: 'image', source: { media_type: 'image/png' } }] }];
    expect(estimateTokens(msgs)).toBeLessThan(30);
  });

  test('纯文本行为不变:string content 按 char/4', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(4000) }])).toBe(1000);
  });

  test('media(audio)大 base64 同样分带,不爆字符计', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'audio', source: { media_type: 'audio/mp3', data: 'A'.repeat(1_400_000) } }] },
    ];
    expect(estimateTokens(msgs)).toBe(IMAGE_TOKEN_LARGE);
  });

  test('回归场景:长对话 + 一张 >430KB 截图,估算远低于 200K 模型 preCompact 水位(144K)', () => {
    const msgs: unknown[] = [];
    for (let i = 0; i < 20; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'msg '.repeat(200) });
    msgs.push({ role: 'user', content: [{ type: 'text', text: '看下这张截图' }, imageBlock(600_000)] });
    // 旧公式:仅图就 ~150K token → 一发图就越线误压。新公式:全部 < 10K。
    expect(estimateTokens(msgs)).toBeLessThan(10_000);
  });
});
