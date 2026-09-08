/**
 * 多模态图片输入 — facade 把 TurnRequest.input.attachments 组成 Anthropic image content
 * block,作为 user 消息 content 数组送 provider(无附件则保持纯字符串,零回归)。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';
import { buildRequestBody } from '../src/provider/anthropic';

const PNG_FIXTURE = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));
const JPEG_FIXTURE = new Uint8Array(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
));

function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

/** 捕获 provider:记录每次 stream 的 ProviderRequest,便于断言 user 消息 content。 */
function capturing(): { provider: LLMProvider; calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(r: ProviderRequest) {
      calls.push(r);
      yield asstText('ok');
    },
  } as LLMProvider;
  return { provider, calls };
}

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    session: { threadId: 'th', agentId: 'ag' },
    input: { text: 'describe this' },
    systemPrompt: { charter: 'C', persona: 'P' },
    tools: [],
    budget: { maxTurns: 4 },
    ...over,
  };
}

async function run(kernel: ForgeaxCoreKernel, r: TurnRequest): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const e of kernel.runTurn(r, new AbortController().signal)) out.push(e);
  return out;
}

function firstUser(calls: ProviderRequest[]): { role: string; content: unknown } {
  const m = calls[0].messages.find((x) => x.role === 'user');
  if (!m) throw new Error('no user message captured');
  return m as { role: string; content: unknown };
}

function legacyImageFiles(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) legacyImageFiles(item, out);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'image_file') out.push(record);
    for (const nested of Object.values(record)) legacyImageFiles(nested, out);
  }
  return out;
}

function expectWireHasNoLegacyImageFiles(wire: unknown, forbiddenPath: string): void {
  expect(legacyImageFiles(wire)).toEqual([]);
  expect(JSON.stringify(wire)).not.toContain(forbiddenPath);
}

function firstBlockByType(value: unknown, type: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstBlockByType(item, type);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === type) return record;
    for (const nested of Object.values(record)) {
      const found = firstBlockByType(nested, type);
      if (found) return found;
    }
  }
  return undefined;
}

function wireCapturing(): { provider: LLMProvider; wires: unknown[][] } {
  const wires: unknown[][] = [];
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(request: ProviderRequest) {
      const body = buildRequestBody({ ...request, enablePromptCaching: false });
      wires.push(body.messages as unknown[]);
      yield asstText(`round-${wires.length}`);
    },
  };
  return { provider, wires };
}

describe('facade 多模态 — image content block', () => {
  test('无附件 → user content 保持纯字符串(零回归)', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req());
    expect(firstUser(calls).content).toBe('describe this');
  });

  test('base64 图片附件 → content 数组 [text, image]', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'describe this', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'QUJD' }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  });

  test('空文本 + 图片附件 → 仅 image block(不注入空 text)', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: '', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'QUJD' }] } }));
    expect(firstUser(calls).content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  test('空文本 + 混合附件 → 仅附件块且保持顺序/MIME/data', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: '', attachments: [
      { kind: 'document', mediaType: 'application/pdf', data: 'UERG' },
      { kind: 'image', mediaType: 'image/jpeg', data: 'QUJD' },
    ] } }));
    expect(firstUser(calls).content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    ]);
  });

  test('空白字符文本 + 图片附件 → 仍保留 text block', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: ' ', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'QUJD' }] } }));
    expect(firstUser(calls).content).toEqual([
      { type: 'text', text: ' ' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  test('空文本 + 多张 base64 图片 → 仅 image blocks 且保持顺序', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(
      k,
      req({
        input: {
          text: '',
          attachments: [
            { kind: 'image', mediaType: 'image/png', data: 'QUJD' },
            { kind: 'image', mediaType: 'image/jpeg', data: 'REVG' },
          ],
        },
      }),
    );
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
    ]);
  });

  test('dataUrl 前缀被剥离 + media_type 从 dataUrl 推断', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'x', attachments: [{ kind: 'image', data: 'data:image/jpeg;base64,WlpaWg==' }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'WlpaWg==' } });
  });

  test('path 附件 → 读盘转 base64 + media_type 从扩展名推断', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-img-'));
    const p = join(dir, 'pic.jpg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);
    writeFileSync(p, bytes);
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'y', attachments: [{ kind: 'image', path: p }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    const src = (content[1] as { source: { media_type: string; data: string } }).source;
    expect(src.media_type).toBe('image/jpeg');
    expect(src.data).toBe(bytes.toString('base64'));
  });

  test('历史 user image_file → ProviderRequest 已是 canonical image block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-history-img-'));
    const p = join(dir, 'history.png');
    const bytes = Buffer.from(PNG_FIXTURE);
    writeFileSync(p, bytes);
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });

    await run(k, req({
      tools: [],
      history: [{
        role: 'user',
        content: [
          { type: 'text', text: 'previous prompt' },
          { type: 'image_file', path: p, mimeType: 'image/png' },
        ],
      }],
    }));

    const content = calls[0].messages[0]?.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'text', text: 'previous prompt' },
      { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
    ]);
    expect(JSON.stringify(calls[0])).not.toContain('image_file');
  });

  test('native mapHistory uses one neutral canonicalizer for user/assistant/tool and preserves tool name correlation', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    const args = { path: '/opaque/tool-input.secret', nested: { type: 'image_file', path: '/opaque/image.png' } };

    await run(k, req({
      tools: [],
      history: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'previous user' }],
        },
        {
          role: 'assistant',
          content: 'previous assistant',
          toolCalls: [{ callId: 'facade-call-1', name: 'lookup_history', args }],
        },
        {
          role: 'tool',
          callId: 'facade-call-1',
          ok: true,
          result: { envelope: { content: [{ type: 'text', text: 'tool result' }] } },
        },
      ],
    }));

    const messages = calls[0].messages;
    expect(messages.slice(0, 3).map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'previous assistant' },
      { type: 'tool_use', id: 'facade-call-1', name: 'lookup_history', input: args },
    ]);
    expect(messages[2].content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'facade-call-1',
      name: 'lookup_history',
      content: [{ type: 'text', text: 'tool result' }],
      is_error: false,
    }]);
    expect(JSON.stringify(messages)).toContain('/opaque/tool-input.secret');
  });

  test('历史 assistant mixed content 与嵌套 tool_result image_file 都保留可用块', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-history-img-'));
    const p = join(dir, 'history.jpg');
    const bytes = Buffer.from(JPEG_FIXTURE);
    writeFileSync(p, bytes);
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });

    await run(k, req({
      tools: [],
      history: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'previous reply' },
            { type: 'image_file', path: p, mimeType: 'image/jpeg' },
            { type: 'tool_use', id: 'tc_1', name: 'noop', input: {} },
          ],
        },
        {
          role: 'tool',
          callId: 'tc_1',
          ok: true,
          result: [{ type: 'text', text: 'tool output' }, { type: 'image_file', path: p, mimeType: 'image/jpeg' }],
        },
      ],
    }));

    const assistantContent = calls[0].messages[0]?.content as Array<Record<string, unknown>>;
    const toolResult = calls[0].messages[1]?.content as Array<Record<string, unknown>>;
    expect(assistantContent.map((block) => block.type)).toEqual(['text', 'image', 'tool_use']);
    expect((assistantContent[1] as { mimeType: string }).mimeType).toBe('image/jpeg');
    expect((toolResult[0] as { content: Array<Record<string, unknown>> }).content.map((block) => block.type)).toEqual(['text', 'image']);
    expect(JSON.stringify(calls[0])).not.toContain('image_file');
  });

  test('历史对象型 tool_result/result 的多层 content envelope 递归归一化', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-history-img-deep-'));
    const p = join(dir, 'nested.png');
    writeFileSync(p, PNG_FIXTURE);
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });

    await run(k, req({
      tools: [],
      history: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'deep-tool', name: 'nested', input: {} }],
        },
        {
          role: 'tool',
          callId: 'deep-tool',
          ok: true,
          result: {
            envelope: {
              content: {
                content: [{ type: 'text', text: 'nested result' }, { type: 'image_file', path: p, mimeType: 'image/png' }],
              },
            },
          },
        },
      ],
    }));

    expectWireHasNoLegacyImageFiles(calls[0], p);
    expect(JSON.stringify(calls[0])).toContain('"type":"image"');
  });

  test('历史图片缺失或 MIME 非图片 → 无路径安全降级，不把旧 block 发给 provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-history-img-'));
    const textPath = join(dir, 'not-an-image.txt');
    writeFileSync(textPath, 'not an image');
    const secretPath = '/private/forgeax-history-secret/missing.png';
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });

    await run(k, req({
      tools: [],
      history: [{
        role: 'user',
        content: [
          { type: 'image_file', path: secretPath, mimeType: 'image/png' },
          { type: 'image_file', path: textPath, mimeType: 'text/plain' },
        ],
      }],
    }));

    expect(calls[0].messages[0]?.content).toEqual([
      { type: 'text', text: '[image unavailable]' },
      { type: 'text', text: '[image unavailable]' },
    ]);
    expect(JSON.stringify(calls[0])).not.toContain('image_file');
    expect(JSON.stringify(calls[0])).not.toContain(secretPath);
  });

  test('stub provider 两轮 history replay：首轮附件，次轮 host-owned image_file 无路径成功发 wire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-history-replay-'));
    const p = join(dir, 'attachment.png');
    writeFileSync(p, PNG_FIXTURE);
    const { provider, wires } = wireCapturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });

    await run(k, req({
      tools: [],
      input: { text: 'first turn with attachment', attachments: [{ kind: 'image', path: p }] },
    }));
    expectWireHasNoLegacyImageFiles(wires[0], p);
    expect(JSON.stringify(wires[0])).toContain('"type":"image"');

    const toolArgs = { query: 'attachment', options: { includeMetadata: true } };
    const secondEvents = await run(k, req({
      tools: [],
      input: { text: 'second turn without attachment' },
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first turn with attachment' },
            { type: 'image_file', path: p, mimeType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'first answer' }],
          toolCalls: [{ callId: 'tool-1', name: 'read_file', args: toolArgs }],
        },
        {
          role: 'tool',
          callId: 'tool-1',
          ok: true,
          result: { envelope: { content: { content: [{ type: 'image_file', path: p, mimeType: 'image/png' }] } } },
        },
      ],
    }));

    expect(secondEvents.some((event) => event.kind === 'turn.done' && event.reason === 'stop')).toBe(true);
    expect(wires).toHaveLength(2);
    expectWireHasNoLegacyImageFiles(wires[1], p);

    const toolUse = firstBlockByType(wires[1], 'tool_use');
    expect(toolUse).toEqual({ type: 'tool_use', id: 'tool-1', name: 'read_file', input: toolArgs });
    const toolResult = firstBlockByType(wires[1], 'tool_result');
    expect(toolResult?.tool_use_id).toBe('tool-1');
    const image = firstBlockByType(toolResult?.content, 'image');
    expect(image?.source).toEqual({ type: 'base64', media_type: 'image/png', data: Buffer.from(PNG_FIXTURE).toString('base64') });
  });

  test('tool-only assistant empty content maps to tool_use-only final wire and keeps matching tool_result', async () => {
    const { provider, wires } = wireCapturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    const toolArgs = { path: '/tmp/example.png' };

    await run(k, req({
      input: { text: 'continue after tool' },
      history: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ callId: 'tool-only-1', name: 'send_media', args: toolArgs }],
        },
        {
          role: 'tool',
          callId: 'tool-only-1',
          ok: true,
          result: 'sent',
        },
      ],
    }));

    const wire = wires[0] as Array<{ role?: string; content?: unknown }>;
    const assistant = wire.find((message) => message.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'tool_use', id: 'tool-only-1', name: 'send_media', input: toolArgs },
    ]);
    const toolResult = firstBlockByType(wire, 'tool_result');
    expect(toolResult).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool-only-1',
      content: [{ type: 'text', text: 'sent' }],
    });
    expect(JSON.stringify(wire)).not.toContain('"text":""');
  });

  test('附件无法解析(空 data)→ 退回纯文本', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'z', attachments: [{ kind: 'image' }] } }));
    expect(firstUser(calls).content).toBe('z');
  });

  test('非 image/document 附件 kind → 跳过,退回纯文本', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'w', attachments: [{ kind: 'file', data: 'AAAA' }] } }));
    expect(firstUser(calls).content).toBe('w');
  });

  test('PDF 附件(kind:document)→ content 数组 [text, document]', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'read this', attachments: [{ kind: 'document', mediaType: 'application/pdf', data: 'UERG' }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'read this' });
    expect(content[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } });
  });

  test('document 附件缺 mediaType → 兜底 application/pdf', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'x', attachments: [{ kind: 'document', data: 'UERG' }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect((content[1] as { source: { media_type: string } }).source.media_type).toBe('application/pdf');
  });

  test('image + document 混合 → 逐个成块,顺序跟随 attachments', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'both', attachments: [
      { kind: 'document', mediaType: 'application/pdf', data: 'UERG' },
      { kind: 'image', mediaType: 'image/png', data: 'QUJD' },
    ] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(['text', 'document', 'image']);
  });
});
