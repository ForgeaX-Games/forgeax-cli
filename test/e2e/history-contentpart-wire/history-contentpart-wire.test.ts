import { afterEach, describe, expect, test } from 'bun:test';
import { startGateway, type RunningGateway, validateWire } from './gateway';
import { runHeadlessCase } from './headless-driver';

const servers: RunningGateway[] = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

describe('history ContentPart wire harness', () => {
  test('runs a real ForgeaxCoreKernel and provider adapter against loopback gateway', async () => {
    const gateway = await startGateway({ port: 0, provider: 'openai-compat', caseId: 'HIST-INLINE-01' });
    servers.push(gateway);
    const result = await runHeadlessCase({ provider: 'openai-compat', caseId: 'HIST-INLINE-01', gatewayUrl: gateway.url });
    expect(gateway.records.length).toBeGreaterThan(0);
    expect(result.provider).toBe('openai-compat');
    expect(result.observations.requestCount).toBe(1);
  });

  test('records a rejected host residue without writing raw payloads', async () => {
    const gateway = await startGateway({ port: 0, provider: 'anthropic-messages', caseId: 'NEG-PATH-01' });
    servers.push(gateway);
    const result = await runHeadlessCase({ provider: 'anthropic-messages', caseId: 'NEG-PATH-01', gatewayUrl: gateway.url, fixtureRoot: '/Users/you' });
    expect(result.requests.length).toBe(1);
    expect(gateway.records[0]?.validator.passed).toBe(true);
    expect(JSON.stringify(gateway.records[0]?.wire)).not.toContain('/Users/you');
    expect(JSON.stringify(gateway.records[0]?.wire)).toContain('image unavailable');
  });

  test('supports deterministic tool response through the real adapter', async () => {
    const gateway = await startGateway({ port: 0, provider: 'gemini', caseId: 'HIST-TOOL-01', scenario: 'tool', maxRequests: 4 });
    servers.push(gateway);
    const result = await runHeadlessCase({ provider: 'gemini', caseId: 'HIST-TOOL-01', gatewayUrl: gateway.url });
    expect(gateway.records.length).toBeGreaterThanOrEqual(2);
    expect(result.observations.toolCallCount).toBeGreaterThanOrEqual(1);
  });

  test('does not confuse system paths or tool schema paths with history residue', () => {
    const result = validateWire('anthropic-messages', {
      system: [{ type: 'text', text: 'Working directory: /Users/you/project' }],
      tools: [{ name: 'read_file', input_schema: { properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }, 1, 'UI-IMG-01');
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('media-dropped-without-degradation');
    expect(result.reasons).not.toContain('absolute-path-leak');
    expect(result.reasons).not.toContain('host-residue:path');
  });

  test('does not treat internal memory extraction as a media user turn', () => {
    const result = validateWire('anthropic-messages', {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'You are now acting as the memory extraction subagent. Conversation:\nhello' }],
      }],
    }, 1, 'UI-IMG-01');
    expect(result.passed).toBe(true);
    expect(result.reasons).not.toContain('media-dropped-without-degradation');
  });

  test('keeps unknown ingress as an explicit safe degradation', async () => {
    const gateway = await startGateway({ port: 0, provider: 'openai-compat', caseId: 'NEG-UNKNOWN-01' });
    servers.push(gateway);
    await runHeadlessCase({ provider: 'openai-compat', caseId: 'NEG-UNKNOWN-01', gatewayUrl: gateway.url });
    expect(gateway.records[0]?.validator.passed).toBe(true);
    expect(gateway.records[0]?.validator.reasons ?? []).not.toContain('unknown-ingress-dropped-without-degradation');
    expect(JSON.stringify(gateway.records[0]?.wire)).not.toContain('FX_ACCEPTANCE_SENTINEL_DO_NOT_LEAK');
    expect(JSON.stringify(gateway.records[0]?.wire)).toMatch(/unavailable|unsupported|degrad/i);
  });
});
