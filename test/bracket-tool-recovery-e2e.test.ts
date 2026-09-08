/**
 * TAPD 1070160897162272877 — personal-19 V1→V2 @forgeax/cli CoreAgent.run recovery.
 *
 * These tests deliberately drive the real CoreAgent loop. The bracket form is
 * never converted into a synthetic tool_result: the only successful recovery
 * is one nudge followed by the provider's native tool_use/id dispatch.
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type {
  LLMProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
  StopReason,
} from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import {
  BRACKET_TOOL_REJECT_MESSAGE,
  BRACKET_TOOL_REPEAT_MESSAGE,
  MAX_BRACKET_TOOL_JSON_DEPTH,
  MAX_BRACKET_TOOL_TEXT_CHARS,
  parseBracketPseudoToolText,
} from '../src/agent/bracket-tool-recovery';

type Block = { type: string; [key: string]: unknown };

function assistant(content: Block[], stopReason: StopReason): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    usage: EMPTY_USAGE,
    stopReason,
  };
}

const text = (value: string): Block[] => [{ type: 'text', text: value }];
const nativeToolUse = (id: string, name: string, input: unknown): Block[] => [
  { type: 'tool_use', id, name, input },
];

function context(tools: AgentTool[], provider: LLMProvider): AgentContext {
  return {
    agentId: 'tapd-1070160897162272877',
    provider,
    config: { systemPromptSlots: [], model: 'test-model', tools, maxTurns: 8 },
    toolContext: {},
  };
}

async function collect(agent: CoreAgent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run({ input: { type: 'user', payload: 'inspect the file', ts: 0 } })) {
    events.push(event);
  }
  return events;
}

function doneReason(events: AgentEvent[]): string | undefined {
  const last = events.at(-1);
  return last?.type === 'done' ? last.terminal.reason : undefined;
}

function assistantText(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant' }> => event.type === 'assistant')
    .flatMap((event) => {
      const payload = event.message.payload as { content?: unknown };
      return Array.isArray(payload.content)
        ? payload.content
            .filter((block): block is { type: 'text'; text: string } => {
              return Boolean(block && typeof block === 'object' && (block as Block).type === 'text' && typeof (block as Block).text === 'string');
            })
            .map((block) => block.text)
        : [];
    });
}

function streamedText(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'stream' }> => event.type === 'stream')
    .flatMap((event) => {
      const stream = event.event as ProviderStreamEvent;
      if (stream.type !== 'content_block_delta') return [];
      const delta = stream.delta as { type?: unknown; text?: unknown } | undefined;
      return delta?.type === 'text_delta' && typeof delta.text === 'string' ? [delta.text] : [];
    });
}

function snapshotMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return JSON.parse(JSON.stringify(messages)) as ProviderMessage[];
}

function readFileTool(reads: string[]): AgentTool {
  return buildTool({
    name: 'read_file',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    inputJSONSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    call: async (input: { path: string }) => {
      reads.push(input.path);
      return { data: `contents of ${input.path}` };
    },
    mapResult: (output, id) => ({
      type: 'tool.result',
      payload: { toolUseId: id, result: output },
      ts: 0,
    }),
    maxResultSizeChars: 10_000,
  });
}

test('seq58/59: bracket end_turn → one nudge → native tool_use dispatch → done', async () => {
  const reads: string[] = [];
  const tool = readFileTool(reads);
  const pseudo = '[called read_file({"path":"games/019ffa33-33e2-7eea-a48b-69bfa73da1db/src/main.ts"})]';
  const chunks = [pseudo.slice(0, 24), pseudo.slice(24, 61), pseudo.slice(61)];
  const requests: ProviderMessage[][] = [];
  let providerCalls = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(request: ProviderRequest) {
      requests.push(snapshotMessages(request.messages));
      if (providerCalls++ === 0) {
        yield { type: 'content_block_start', index: 0, blockType: 'text' };
        for (const chunk of chunks) {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } };
        }
        yield { type: 'content_block_stop', index: 0, block: { type: 'text', text: pseudo } };
        yield assistant(text(pseudo), 'end_turn');
        return;
      }
      if (providerCalls === 2) {
        yield assistant(nativeToolUse('native-read-1', 'read_file', {
          path: 'games/019ffa33-33e2-7eea-a48b-69bfa73da1db/src/main.ts',
        }), 'tool_use');
        return;
      }
      yield assistant(text('The file was read through the native tool interface.'), 'end_turn');
    },
  };

  const events = await collect(new CoreAgent({ context: context([tool], provider), maxToolErrorStreak: 0 }));

  expect(doneReason(events)).toBe('completed');
  expect(providerCalls).toBe(3);
  expect(reads).toEqual(['games/019ffa33-33e2-7eea-a48b-69bfa73da1db/src/main.ts']);
  expect(events.filter((event) => event.type === 'tool_call')).toEqual([
    { type: 'tool_call', toolName: 'read_file', toolUseId: 'native-read-1', input: {
      path: 'games/019ffa33-33e2-7eea-a48b-69bfa73da1db/src/main.ts',
    } },
  ]);

  const eventWire = JSON.stringify(events);
  expect(eventWire).not.toContain(pseudo);
  expect(assistantText(events)).not.toContain(pseudo);
  expect(JSON.stringify(requests[1])).toContain('Repeat the same request through the native tool interface');
  expect(JSON.stringify(requests[1])).toContain('games/019ffa33-33e2-7eea-a48b-69bfa73da1db/src/main.ts');
  expect(JSON.stringify(requests[1])).not.toContain(pseudo);
  // Native history owns the only tool exchange; no synthetic tool_result was
  // produced for the first text-form response.
  expect(JSON.stringify(requests[2])).toContain('native-read-1');
  expect(JSON.stringify(requests[2])).toContain('tool_result');
});

test('native tool_use remains unchanged and dispatches once', async () => {
  const reads: string[] = [];
  const tool = readFileTool(reads);
  const requests: ProviderMessage[][] = [];
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(request: ProviderRequest) {
      requests.push(snapshotMessages(request.messages));
      call++;
      if (call === 1) {
        yield assistant(nativeToolUse('native-1', 'read_file', { path: '/tmp/native.ts' }), 'tool_use');
      } else {
        yield assistant(text('native done'), 'end_turn');
      }
    },
  };

  const events = await collect(new CoreAgent({ context: context([tool], provider), maxToolErrorStreak: 0 }));

  expect(doneReason(events)).toBe('completed');
  expect(reads).toEqual(['/tmp/native.ts']);
  expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
  expect(JSON.stringify(requests[1])).toContain('tool_result');
});

test('suppresses a pseudo-call split across text-block indexes before aggregate classification', async () => {
  const reads: string[] = [];
  const tool = readFileTool(reads);
  const pseudo = '[called read_file({"path":"games/split.ts"})]';
  const first = pseudo.slice(0, 23);
  const second = pseudo.slice(23);
  let calls = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'content_block_start', index: 0, blockType: 'text' };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first } };
        yield { type: 'content_block_stop', index: 0, block: { type: 'text', text: first } };
        yield { type: 'content_block_start', index: 1, blockType: 'text' };
        yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: second } };
        yield { type: 'content_block_stop', index: 1, block: { type: 'text', text: second } };
        yield assistant(text(pseudo), 'end_turn');
      } else if (calls === 2) {
        yield assistant(nativeToolUse('split-read-1', 'read_file', { path: 'games/split.ts' }), 'tool_use');
      } else {
        yield assistant(text('split read complete'), 'end_turn');
      }
    },
  };

  const events = await collect(new CoreAgent({ context: context([tool], provider), maxToolErrorStreak: 0 }));

  expect(doneReason(events)).toBe('completed');
  expect(calls).toBe(3);
  expect(reads).toEqual(['games/split.ts']);
  expect(streamedText(events)).toEqual([]);
  expect(assistantText(events)).not.toContain(pseudo);
  expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
});

test('oversize pseudo-call split across stream deltas never leaks and terminates model_error', async () => {
  const reads: string[] = [];
  const tool = readFileTool(reads);
  const pseudo = `[called read_file({"blob":"${'x'.repeat(MAX_BRACKET_TOOL_TEXT_CHARS + 512)}"})]`;
  const chunks = Array.from({ length: Math.ceil(pseudo.length / 4096) }, (_, index) =>
    pseudo.slice(index * 4096, (index + 1) * 4096),
  );
  let calls = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() {
      calls++;
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      for (const chunk of chunks) {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } };
      }
      yield { type: 'content_block_stop', index: 0, block: { type: 'text', text: pseudo } };
      yield assistant(text(pseudo), 'end_turn');
    },
  };

  const events = await collect(new CoreAgent({ context: context([tool], provider), maxToolErrorStreak: 0 }));

  expect(calls).toBe(1);
  expect(reads).toHaveLength(0);
  expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
  expect(streamedText(events)).toEqual([]);
  expect(assistantText(events)).toContain(BRACKET_TOOL_REJECT_MESSAGE);
  expect(doneReason(events)).toBe('model_error');
});

test('incomplete bracket-prefixed aggregate stays fail-closed', async () => {
  const reads: string[] = [];
  const incomplete = '[called read_file({"path":"games/incomplete.ts"}';
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() {
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: incomplete } };
      yield { type: 'content_block_stop', index: 0, block: { type: 'text', text: incomplete } };
      yield assistant(text(incomplete), 'end_turn');
    },
  };

  const events = await collect(
    new CoreAgent({ context: context([readFileTool(reads)], provider), maxToolErrorStreak: 0 }),
  );

  expect(reads).toHaveLength(0);
  expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
  expect(streamedText(events)).toEqual([]);
  expect(assistantText(events)).toContain(BRACKET_TOOL_REJECT_MESSAGE);
  expect(doneReason(events)).toBe('model_error');
});

test('abnormal EOF drops an incomplete candidate and terminates model_error', async () => {
  const reads: string[] = [];
  const incomplete = '[called read_file({"path":"games/eof.ts"}';
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() {
      yield { type: 'content_block_start', index: 0, blockType: 'text' };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: incomplete } };
    },
  };

  const events = await collect(
    new CoreAgent({ context: context([readFileTool(reads)], provider), maxToolErrorStreak: 0 }),
  );

  expect(reads).toHaveLength(0);
  expect(streamedText(events)).toEqual([]);
  expect(assistantText(events)).toContain(BRACKET_TOOL_REJECT_MESSAGE);
  expect(doneReason(events)).toBe('model_error');
});

describe('standalone malformed/unavailable bracket forms fail closed', () => {
  const cases = [
    ['invalid JSON', '[called read_file({"path":)]'],
    ['unregistered tool', '[called missing({"path":"/tmp/x"})]'],
    ['over-limit JSON arguments', `[called read_file({"blob":"${'x'.repeat(17_000)}"})]`],
    ['non-clean terminal', '[called read_file({"path":"/tmp/x"})]'],
  ] as const;

  for (const [label, pseudo] of cases) {
    test(label, async () => {
      const reads: string[] = [];
      const tool = readFileTool(reads);
      let calls = 0;
      const provider: LLMProvider = {
        api: 'stub',
        async *stream() {
          calls++;
          yield assistant(text(pseudo), label === 'non-clean terminal' ? 'max_tokens' : 'end_turn');
        },
      };

      const events = await collect(new CoreAgent({ context: context([tool], provider), maxToolErrorStreak: 0 }));

      expect(calls).toBe(1);
      expect(reads).toHaveLength(0);
      expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
      expect(doneReason(events)).toBe('model_error');
      expect(JSON.stringify(events)).not.toContain('[called ');
      expect(assistantText(events)).toContain(BRACKET_TOOL_REJECT_MESSAGE);
    });
  }
});

test('prose containing bracket-looking text is ordinary text and never dispatches', async () => {
  const reads: string[] = [];
  const prose = 'I can mention [called read_file({"path":"/tmp/x"})] safely.';
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() {
      yield assistant(text(prose), 'end_turn');
    },
  };

  const events = await collect(new CoreAgent({ context: context([readFileTool(reads)], provider), maxToolErrorStreak: 0 }));

  expect(doneReason(events)).toBe('completed');
  expect(reads).toHaveLength(0);
  expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
  expect(assistantText(events)).toContain(prose);
});

test('a repeated valid pseudo-call is terminal, safe, and never dispatched', async () => {
  const reads: string[] = [];
  const pseudo = '[called read_file({"path":"/tmp/repeated.ts"})]';
  let calls = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() {
      calls++;
      yield assistant(text(pseudo), 'end_turn');
    },
  };

  const events = await collect(new CoreAgent({ context: context([readFileTool(reads)], provider), maxToolErrorStreak: 0 }));

  expect(calls).toBe(2); // first pseudo is nudged once; second is not nudged again
  expect(reads).toHaveLength(0);
  expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
  expect(doneReason(events)).toBe('model_error');
  expect(JSON.stringify(events)).not.toContain(pseudo);
  expect(assistantText(events)).toContain(BRACKET_TOOL_REPEAT_MESSAGE);
});

test('cancellation drops a buffered pseudo-call and never leaks it', async () => {
  const pseudo = '[called read_file({"path":"/tmp/cancelled.ts"})]';
  const tool = readFileTool([]);
  let agent: CoreAgent | null = null;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream() {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: pseudo.slice(0, 20) } };
      agent?.abort('cancelled');
      yield assistant(text(pseudo), 'end_turn');
    },
  };
  agent = new CoreAgent({ context: context([tool], provider), maxToolErrorStreak: 0 });

  const events = await collect(agent);

  expect(doneReason(events)).toBe('aborted_streaming');
  expect(JSON.stringify(events)).not.toContain('[called ');
});

test('parser rejects invalid roots and resource limits', () => {
  expect(parseBracketPseudoToolText('[called read_file({"path":"/tmp/x"})]')?.name).toBe('read_file');
  expect(parseBracketPseudoToolText('[called read_file([1,2])]')).toBeNull();
  expect(parseBracketPseudoToolText('[called read_file(null)]')).toBeNull();
  expect(parseBracketPseudoToolText('[called read_file({"path":})]')).toBeNull();

  let nested: unknown = {};
  for (let i = 0; i < MAX_BRACKET_TOOL_JSON_DEPTH + 2; i++) nested = { child: nested };
  expect(parseBracketPseudoToolText(`[called read_file(${JSON.stringify(nested)})]`)).toBeNull();
});
