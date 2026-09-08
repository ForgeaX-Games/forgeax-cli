import { describe, expect, test } from 'bun:test';
import { registerProvider, resolveProvider } from '../src/provider/register';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import { NOOP_OBS, type CoreLogger } from '../src/observability/contract';
import type {
  ProviderBoundaryTraceEvent,
  ProviderRequest,
  ProviderStreamEvent,
} from '../src/provider/types';

const REQUEST: ProviderRequest = {
  model: 'trace-model[1m]',
  system: [{ type: 'text', text: 'SYSTEM_SECRET_sk-ant-1234567890123456' }],
  tools: [{ name: 'secret_tool', inputSchema: { secret: 'DO_NOT_LOG' } }],
  messages: [{ role: 'user', content: 'BODY_SECRET_Bearer abcdefghijklmnopqrstuvwxyz' }],
  maxOutputTokens: 42,
};

async function drain(stream: AsyncIterable<ProviderStreamEvent>): Promise<void> {
  for await (const _event of stream) {
    // consume the resolved provider adapter
  }
}

describe('resolved provider adapter boundary trace', () => {
  test('surrounds the actual adapter stream with correlated metadata and no body or credentials', async () => {
    const endpoint = new URL('https://provider.example.test/v1/messages');
    endpoint.username = 'user';
    endpoint.password = 'password';
    endpoint.searchParams.set('token', 'secret');
    registerProvider('trace-boundary-success-84', () => ({
      api: 'actual-safe-adapter',
      endpointOrigin: endpoint.href,
      async *stream(req) {
        expect(req.model).toBe('trace-model');
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'RESPONSE_SECRET' }] },
          usage: {
            inputTokens: 101,
            outputTokens: 7,
            cacheCreationInputTokens: 11,
            cacheReadInputTokens: 13,
          },
          stopReason: 'end_turn',
          requestId: 'provider-request-84',
          httpStatus: 200,
        };
      },
    }));

    const records: ProviderBoundaryTraceEvent[] = [];
    const provider = resolveProvider('trace-boundary-success-84', {
      apiKey: 'sk-ant-credential-never-logged',
    });
    await drain(provider.stream(REQUEST, {
      signal: new AbortController().signal,
      boundaryTrace: {
        callId: 'call-84',
        threadId: 'thread-84',
        emit: (record) => records.push(record),
      },
    }));

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      phase: 'start',
      callId: 'call-84',
      threadId: 'thread-84',
      providerApi: 'actual-safe-adapter',
      endpointOrigin: 'https://provider.example.test',
      model: 'trace-model',
      requestScale: { systemBlocks: 1, messages: 1, tools: 1, maxOutputTokens: 42 },
    });
    expect(records[1]).toMatchObject({
      phase: 'complete',
      sequence: records[0].sequence,
      logicalStatus: 'completed',
      stopReason: 'end_turn',
      requestId: 'provider-request-84',
      httpStatus: 200,
      usage: { inputTokens: 101, outputTokens: 7 },
    });
    const serialized = JSON.stringify(records);
    for (const secret of ['SYSTEM_SECRET', 'BODY_SECRET', 'RESPONSE_SECRET', 'password', 'token=secret', 'credential-never-logged', 'DO_NOT_LOG']) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('failure records status and error class but never the provider error text', async () => {
    registerProvider('trace-boundary-error-84', () => ({
      api: 'actual-error-adapter',
      async *stream() {
        const error = new Error('Bearer super-secret-provider-body') as Error & { status: number };
        error.name = 'ProviderRejectedError';
        error.status = 429;
        throw error;
      },
    }));

    const records: ProviderBoundaryTraceEvent[] = [];
    const provider = resolveProvider('trace-boundary-error-84', { apiKey: 'unused-secret' });
    await expect(drain(provider.stream(REQUEST, {
      signal: new AbortController().signal,
      boundaryTrace: {
        callId: 'failed-call-84',
        threadId: 'failed-thread-84',
        emit: (record) => records.push(record),
      },
    }))).rejects.toThrow('super-secret-provider-body');

    expect(records.at(-1)).toMatchObject({
      phase: 'error',
      callId: 'failed-call-84',
      threadId: 'failed-thread-84',
      providerApi: 'actual-error-adapter',
      logicalStatus: 'error',
      httpStatus: 429,
      errorClass: 'ProviderRejectedError',
    });
    expect(JSON.stringify(records)).not.toContain('super-secret-provider-body');
  });

  test('kernel gate attaches the same callId/threadId to the actual adapter record', async () => {
    registerProvider('trace-boundary-kernel-84', () => ({
      api: 'actual-kernel-adapter',
      endpointOrigin: 'https://kernel-provider.example.test/v1/messages',
      async *stream() {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          usage: {
            inputTokens: 3,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: 'end_turn',
          requestId: 'kernel-request-84',
          httpStatus: 200,
        };
      },
    }));
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger: CoreLogger = {
      debug() {},
      info(msg, fields) { logs.push({ msg, fields }); },
      warn() {},
      error() {},
      child() { return logger; },
    };
    const provider = resolveProvider('trace-boundary-kernel-84', { apiKey: 'not-logged' });
    const kernel = new ForgeaxCoreKernel({
      provider,
      providerBoundaryTrace: true,
      executeTool: async () => null,
      observability: { tracer: NOOP_OBS.tracer, logger },
    });
    for await (const _event of kernel.runTurn({
      callId: 'kernel-call-84',
      session: { threadId: 'kernel-thread-84', agentId: 'forge' },
      input: { text: 'hello' },
      systemPrompt: { charter: 'charter', persona: 'persona' },
      tools: [],
      budget: { maxTurns: 1 },
      model: 'kernel-model',
    }, new AbortController().signal)) {
      // consume the real facade turn
    }
    const boundary = logs.filter((record) => record.msg === 'provider.adapter.boundary');
    expect(boundary).toHaveLength(2);
    expect(boundary[0].fields).toMatchObject({
      phase: 'start',
      callId: 'kernel-call-84',
      threadId: 'kernel-thread-84',
      providerApi: 'actual-kernel-adapter',
    });
    expect(boundary[1].fields).toMatchObject({
      phase: 'complete',
      requestId: 'kernel-request-84',
      httpStatus: 200,
    });
  });
});
