/**
 * Headless acceptance driver for history ContentPart wire cases.
 *
 * The only network boundary is the loopback gateway. The driver constructs the
 * real ForgeaxCoreKernel and resolves the real CLI provider adapter; it never
 * imports or calls the facade's private mapHistory helper.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ForgeaxCoreKernel } from '../../../src/kernel-facade/forgeax-core-kernel';
import { resolveProvider } from '../../../src/provider/register';
import type { HarnessProvider } from './gateway';
import type { KernelEvent, TurnMessage, TurnRequest } from '@forgeax/agent-runtime/contract';

export interface DriverOptions {
  provider: HarnessProvider;
  caseId: string;
  gatewayUrl: string;
  output?: string;
  model?: string;
  scenario?: 'text' | 'tool';
  fixtureRoot?: string;
}

export interface DriverRun {
  caseId: string;
  provider: HarnessProvider;
  requests: Array<{ turn: number; events: KernelEvent[]; error?: string }>;
  observations: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function imagePart(): Record<string, unknown> {
  return { type: 'image', data: PNG_B64, mimeType: 'image/png' };
}

function filePart(root: string | undefined): Record<string, unknown> {
  return { type: 'image_file', path: resolve(root ?? '.', 'pixel.png'), mimeType: 'image/png' };
}

function baseRequest(caseId: string, model: string, history?: TurnMessage[]): TurnRequest {
  return {
    callId: `${caseId}-turn`,
    session: { threadId: `${caseId}-thread`, agentId: 'history-harness' },
    input: { text: 'Reply with the deterministic harness result.' },
    history,
    systemPrompt: { charter: 'Controlled history ContentPart harness.', persona: 'Return a short result.' },
    tools: [{ name: 'ui_screenshot', description: 'Controlled screenshot fixture.', inputSchema: { type: 'object', properties: {} } }],
    budget: { maxTurns: 4 },
    model,
    permissionMode: 'unrestricted',
  };
}

function providerModel(provider: HarnessProvider): string {
  switch (provider) {
    case 'anthropic-messages': return 'claude-3-5-sonnet';
    case 'openai-compat': return 'gpt-4o-mini';
    case 'openai-responses': return 'gpt-4o-mini';
    case 'gemini': return 'gemini-2.0-flash';
  }
}

async function oneTurn(options: DriverOptions, turn: number, history: TurnMessage[] | undefined, inputText?: string): Promise<{ events: KernelEvent[]; error?: string }> {
  const provider = resolveProvider(options.provider, {
    apiKey: 'history-harness-key',
    baseUrl: options.gatewayUrl,
    headers: { 'x-forgeax-case': options.caseId, 'x-forgeax-turn': String(turn) },
  });
  const kernel = new ForgeaxCoreKernel({
    provider,
    executeTool: async (name) => {
      if (name === 'ui_screenshot') return { type: 'image', data: PNG_B64, mimeType: 'image/png' };
      return { ok: true, name };
    },
  });
  const request = baseRequest(options.caseId, options.model ?? providerModel(options.provider), history);
  if (inputText) request.input.text = inputText;
  const events: KernelEvent[] = [];
  try {
    for await (const event of kernel.runTurn(request, new AbortController().signal)) events.push(event);
    return { events };
  } catch (error) {
    return { events, error: error instanceof Error ? error.message : String(error) };
  }
}

function inlineHistory(): TurnMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Earlier user turn.' }, imagePart()] },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier assistant turn.' }, imagePart()] },
  ];
}

function toolHistory(result: unknown, callId = 'call_1', name = 'ui_screenshot'): TurnMessage[] {
  return [
    { role: 'user', content: 'Take a screenshot.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input: {} }], toolCalls: [{ callId, name, args: {} }] },
    { role: 'tool', callId, ok: true, result },
  ];
}

function partsForDegrade(root?: string): Array<{ type: string; part: Record<string, unknown> }> {
  return [
    { type: 'audio', part: { type: 'audio', data: 'AA==', mimeType: 'audio/wav' } },
    { type: 'video', part: { type: 'video', data: 'AA==', mimeType: 'video/mp4' } },
    { type: 'audio_file', part: { type: 'audio_file', path: resolve(root ?? '.', 'sample.wav'), mimeType: 'audio/wav' } },
    { type: 'video_file', part: { type: 'video_file', path: resolve(root ?? '.', 'sample.mp4'), mimeType: 'video/mp4' } },
    { type: 'text_file', part: { type: 'text_file', path: resolve(root ?? '.', 'secret.txt'), mimeType: 'text/plain' } },
  ];
}

function unknownHistory(root?: string): TurnMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'Unknown ingress.' }, { type: 'future_secret_blob', token: 'FX_ACCEPTANCE_SENTINEL_DO_NOT_LEAK' }] }, { role: 'assistant', content: 'ok' }];
}

function emptyHistory(): TurnMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'assistant', content: [] },
  ];
}

function pathHistory(root?: string): TurnMessage[] {
  return [{ role: 'user', content: [filePart(root)] }, { role: 'assistant', content: 'path check' }];
}

export async function runHeadlessCase(options: DriverOptions): Promise<DriverRun> {
  const startedAt = new Date().toISOString();
  const requests: DriverRun['requests'] = [];
  const caseId = options.caseId;
  if (caseId === 'HIST-INLINE-01' || caseId.startsWith('WIRE-')) {
    requests.push({ turn: 1, ...(await oneTurn(options, 1, inlineHistory())) });
  } else if (caseId === 'HIST-TOOL-01') {
    const first = await oneTurn({ ...options, scenario: 'tool' }, 1, undefined, 'Take a screenshot now.');
    requests.push({ turn: 1, ...first });
    const toolCall = first.events.find((event): event is Extract<KernelEvent, { kind: 'tool.call' }> => event.kind === 'tool.call');
    const toolResult = first.events.find((event): event is Extract<KernelEvent, { kind: 'tool.result' }> => event.kind === 'tool.result');
    const callId = toolCall?.callId ?? 'call_1';
    requests.push({ turn: 2, ...(await oneTurn(options, 2, toolHistory(toolResult?.result ?? { type: 'image', data: PNG_B64, mimeType: 'image/png' }, callId, toolCall?.name ?? 'ui_screenshot'), 'Reference the screenshot from the previous turn.')) });
  } else if (caseId === 'HIST-TOOL-FILE-01') {
    requests.push({ turn: 1, ...(await oneTurn(options, 1, toolHistory({ type: 'image_file', path: resolve(options.fixtureRoot ?? '.', 'pixel.png'), mimeType: 'image/png' }))) });
    requests.push({ turn: 2, ...(await oneTurn(options, 2, toolHistory({ type: 'image_file', path: resolve(options.fixtureRoot ?? '.', 'missing.png'), mimeType: 'image/png' }), 'Continue after the tool image is unavailable.')) });
  } else if (caseId === 'DEGRADE-AV-01') {
    let turn = 1;
    for (const role of ['user', 'assistant', 'tool'] as const) {
      for (const item of partsForDegrade(options.fixtureRoot)) {
        const history: TurnMessage[] = role === 'user'
          ? [{ role: 'user', content: [item.part] }]
          : role === 'assistant'
            ? [{ role: 'assistant', content: [item.part] }]
            : toolHistory([item.part]);
        requests.push({ turn, ...(await oneTurn(options, turn++, history, `Degrade ${role}/${item.type}.`)) });
      }
    }
  } else if (caseId === 'NEG-UNKNOWN-01') {
    requests.push({ turn: 1, ...(await oneTurn(options, 1, unknownHistory(options.fixtureRoot))) });
  } else if (caseId === 'NEG-EMPTY-01') {
    requests.push({ turn: 1, ...(await oneTurn(options, 1, emptyHistory())) });
  } else if (caseId === 'NEG-PATH-01') {
    requests.push({ turn: 1, ...(await oneTurn(options, 1, pathHistory(options.fixtureRoot))) });
  } else if (caseId === 'GEM-NAME-01') {
    requests.push({ turn: 1, ...(await oneTurn(options, 1, toolHistory('tool screenshot result', 'call_1', 'ui_screenshot'))) });
  } else {
    requests.push({ turn: 1, ...(await oneTurn(options, 1, undefined)) });
  }
  const endedAt = new Date().toISOString();
  const result: DriverRun = {
    caseId,
    provider: options.provider,
    requests,
    observations: {
      requestCount: requests.length,
      errorCount: requests.filter((request) => request.error || request.events.some((event) => event.kind === 'error')).length,
      toolCallCount: requests.flatMap((request) => request.events).filter((event) => event.kind === 'tool.call').length,
      note: caseId === 'HIST-TOOL-01' ? 'raw tool result is recorded from kernel events; second turn uses a controlled canonical projection because this harness does not implement product persistence.' : undefined,
    },
    startedAt,
    endedAt,
  };
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(result, null, 2));
  }
  return result;
}

function cliArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? 'true' : (argv[++i] ?? 'true');
  }
  return out;
}

if (import.meta.main) {
  const parsed = cliArgs(process.argv.slice(2));
  const provider = parsed.provider as HarnessProvider;
  if (!parsed.provider || !parsed.case || !parsed['gateway-url']) {
    console.error('usage: bun headless-driver.ts --provider <...> --case <CASE_ID> --gateway-url http://127.0.0.1:PORT [--output PATH] [--fixture-root PATH]');
    process.exit(2);
  }
  const result = await runHeadlessCase({
    provider,
    caseId: parsed.case,
    gatewayUrl: parsed['gateway-url'],
    output: parsed.output,
    model: parsed.model,
    fixtureRoot: parsed['fixture-root'],
    scenario: parsed.scenario === 'tool' ? 'tool' : 'text',
  });
  console.log(JSON.stringify({ caseId: result.caseId, provider: result.provider, observations: result.observations, output: parsed.output ?? null }));
}
