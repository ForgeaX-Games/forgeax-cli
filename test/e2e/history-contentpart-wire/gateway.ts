/**
 * Local, fail-closed provider gateway for the history ContentPart harness.
 *
 * This is deliberately a test boundary: it never pretends to be a third-party
 * provider. It records only redacted request structure, validates the final
 * provider-shaped body, and returns a deterministic stream that the real CLI
 * provider adapter must parse.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type HarnessProvider =
  | 'anthropic-messages'
  | 'openai-compat'
  | 'openai-responses'
  | 'gemini';

export interface GatewayOptions {
  host?: string;
  port: number;
  provider: HarnessProvider;
  caseId: string;
  manifest?: string;
  scenario?: 'text' | 'tool';
  maxRequests?: number;
  /** Accept the real Studio native provider request, which has no harness-only headers. */
  allowUntaggedUi?: boolean;
}

export interface ValidationResult {
  passed: boolean;
  reasons: string[];
  provider: HarnessProvider;
  requestIndex: number;
}

export interface GatewayRecord {
  requestIndex: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  wire: unknown;
  response: { status: number; stream: string };
  validator: ValidationResult;
  receivedAt: string;
}

export interface RunningGateway {
  readonly url: string;
  readonly records: GatewayRecord[];
  readonly server: ReturnType<typeof Bun.serve>;
  close(): Promise<void>;
}

const PROVIDERS = new Set<HarnessProvider>([
  'anthropic-messages',
  'openai-compat',
  'openai-responses',
  'gemini',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function redacted(value: unknown, key = '', depth = 0): unknown {
  if (depth > 12) return '<redacted:depth-limit>';
  if (typeof value === 'string') {
    if (/^data:[^,]+,/.test(value)) return `<redacted:data-url:${sha256(value)}>`;
    if (/FX_ACCEPTANCE_SENTINEL|sk-[A-Za-z0-9]|Bearer\s+/i.test(value)) return '<redacted:secret>';
    if (/(^|[/\\])Users[/\\]|(^|[/\\])private[/\\]|\.forgeax/i.test(value)) return '<redacted:path>';
    return value.length > 2000 ? `<redacted:string:${value.length}>` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redacted(item, key, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const lower = childKey.toLowerCase();
      if (lower === 'data' || lower === 'base64' || lower === 'authorization' || lower.includes('secret')) {
        const text = typeof childValue === 'string' ? childValue : JSON.stringify(childValue) ?? '';
        out[childKey] = `<redacted:${lower}:${sha256(text)}>`;
      } else if (lower === 'path' || lower === 'filepath' || lower === 'file_path') {
        out[childKey] = '<redacted:path>';
      } else {
        out[childKey] = redacted(childValue, childKey, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function hasString(value: unknown, predicate: (text: string) => boolean): boolean {
  if (typeof value === 'string') return predicate(value);
  if (Array.isArray(value)) return value.some((item) => hasString(item, predicate));
  if (value && typeof value === 'object') return Object.values(value).some((item) => hasString(item, predicate));
  return false;
}

/**
 * Return only provider message content that represents model-visible
 * conversation data. System prompts and tool schemas are deliberately not
 * included: the Studio system prompt may contain the host working directory,
 * while a tool input schema legitimately contains fields such as `path`.
 * Neither is a history ContentPart and recursively scanning the whole provider
 * envelope makes the loopback gateway report false positives before it can
 * test the actual bug boundary.
 */
function conversationContent(provider: HarnessProvider, body: Record<string, unknown>): unknown[] {
  if (provider === 'anthropic-messages' || provider === 'openai-compat') {
    return (Array.isArray(body.messages) ? body.messages : [])
      .filter(isRecord)
      .map((message) => message.content);
  }
  if (provider === 'openai-responses') {
    const values: unknown[] = [];
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (!isRecord(item)) continue;
      if (item.type === 'function_call_output') values.push(item.output);
      else if (Object.prototype.hasOwnProperty.call(item, 'content')) values.push(item.content);
      else if (item.type === 'input_text' || item.type === 'input_image' || item.type === 'input_file') values.push(item);
    }
    return values;
  }
  return (Array.isArray(body.contents) ? body.contents : [])
    .filter(isRecord)
    .flatMap((content) => Array.isArray(content.parts) ? content.parts : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonEmptyContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.length > 0;
}

function hostResidue(value: unknown): string | undefined {
  let reason: string | undefined;
  const visit = (node: unknown, topLevel = false): void => {
    if (reason) return;
    if (Array.isArray(node)) return node.forEach((item) => visit(item, false));
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (lower === 'path' || lower === 'incontainer' || (lower === 'mimetype' && topLevel)) {
        reason = `host-residue:${key}`;
        return;
      }
      if (typeof child === 'string' && /^data:[^,]+,/.test(child)) continue;
      if (key === 'type' && typeof child === 'string' && /_file$/.test(child)) {
        reason = `host-tag:${child}`;
        return;
      }
      visit(child, false);
    }
  };
  visit(value, true);
  return reason;
}

function validateCommon(body: Record<string, unknown>, provider: HarnessProvider): string[] {
  const reasons: string[] = [];
  const visibleContent = conversationContent(provider, body);
  if (hasString(visibleContent, (text) => text.includes('FX_ACCEPTANCE_SENTINEL'))) reasons.push('secret-sentinel-leak');
  if (hasString(visibleContent, (text) => /(?:^|[/\\])Users[/\\]|(?:^|[/\\])private[/\\]/.test(text))) {
    reasons.push('absolute-path-leak');
  }
  const residue = hostResidue(visibleContent);
  if (residue) reasons.push(residue);
  if (provider === 'anthropic-messages') {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) reasons.push('messages-empty');
    for (const [index, raw] of (Array.isArray(messages) ? messages : []).entries()) {
      if (!isRecord(raw) || (raw.role !== 'user' && raw.role !== 'assistant')) reasons.push(`message-${index}-role`);
      if (isRecord(raw) && !nonEmptyContent(raw.content)) reasons.push(`message-${index}-content-empty`);
    }
  }
  if (provider === 'openai-compat') {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) reasons.push('messages-empty');
    for (const [index, raw] of (Array.isArray(messages) ? messages : []).entries()) {
      if (!isRecord(raw) || !['system', 'user', 'assistant', 'tool'].includes(String(raw.role))) reasons.push(`message-${index}-role`);
      if (isRecord(raw) && raw.role === 'tool' && !nonEmptyContent(raw.content)) reasons.push(`message-${index}-tool-empty`);
    }
  }
  if (provider === 'openai-responses') {
    if (!Array.isArray(body.input) || body.input.length === 0) reasons.push('input-empty');
    for (const [index, raw] of (Array.isArray(body.input) ? body.input : []).entries()) {
      if (!isRecord(raw)) reasons.push(`input-${index}-not-object`);
      if (isRecord(raw) && raw.type === 'function_call_output' && typeof raw.output === 'string' && !raw.output.trim()) {
        reasons.push(`input-${index}-function-output-empty`);
      }
    }
  }
  if (provider === 'gemini') {
    const contents = body.contents;
    if (!Array.isArray(contents) || contents.length === 0) reasons.push('contents-empty');
    for (const [index, raw] of (Array.isArray(contents) ? contents : []).entries()) {
      if (!isRecord(raw) || !['user', 'model'].includes(String(raw.role))) reasons.push(`content-${index}-role`);
      if (isRecord(raw) && (!Array.isArray(raw.parts) || raw.parts.length === 0)) reasons.push(`content-${index}-parts-empty`);
      const parts = isRecord(raw) && Array.isArray(raw.parts) ? raw.parts : [];
      for (const [partIndex, part] of parts.entries()) {
        if (isRecord(part) && isRecord(part.functionResponse)) {
          const name = part.functionResponse.name;
          if (typeof name !== 'string' || !name || name === 'unknown_tool') reasons.push(`content-${index}-part-${partIndex}-tool-name`);
        }
      }
    }
  }
  return reasons;
}

function hasProviderMedia(provider: HarnessProvider, body: Record<string, unknown>): boolean {
  const has = (predicate: (node: Record<string, unknown>) => boolean): boolean => {
    let found = false;
    const visit = (node: unknown): void => {
      if (found) return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (!isRecord(node)) return;
      if (predicate(node)) {
        found = true;
        return;
      }
      Object.values(node).forEach(visit);
    };
    visit(body);
    return found;
  };
  switch (provider) {
    case 'anthropic-messages':
      return has((node) => node.type === 'image' && isRecord(node.source) && node.source.type === 'base64') ||
        has((node) => node.type === 'document' && isRecord(node.source));
    case 'openai-compat':
      return has((node) => node.type === 'image_url' && isRecord(node.image_url)) ||
        has((node) => node.type === 'file' && isRecord(node.file)) ||
        has((node) => node.type === 'input_audio' && isRecord(node.input_audio));
    case 'openai-responses':
      return has((node) => node.type === 'input_image' && typeof node.image_url === 'string') ||
        has((node) => node.type === 'input_file');
    case 'gemini':
      return has((node) => isRecord(node.inlineData) && typeof node.inlineData.data === 'string');
  }
}

function hasExplicitDegradation(body: Record<string, unknown>): boolean {
  const semanticKeys = new Set(['text', 'content', 'output', 'result', 'message', 'error', 'description']);
  const visit = (node: unknown, key = ''): boolean => {
    if (typeof node === 'string') {
      if (!semanticKeys.has(key.toLowerCase())) return false;
      // Provider adapters use a stable generic marker when the original
      // neutral part has no provider-native representation. The marker itself
      // is the explicit degradation; it is not an empty/drop path.
      if (/(?:content|tool result) unavailable|content unavailable|empty content omitted|\[(?:image|file|audio|video|document) content\]/i.test(node)) return true;
      return /(?:\[(?:image|图片|媒体|附件|audio|video|document|file)[^\]]*(?:unavailable|不可用|未直接发送|不能回放|降级)|(?:unavailable|不可用|未直接发送|不能回放|降级)[^\n]*(?:image|图片|媒体|附件|audio|video|document|file))/i.test(node);
    }
    if (Array.isArray(node)) return node.some((item) => visit(item, key));
    if (!isRecord(node)) return false;
    return Object.entries(node).some(([childKey, childValue]) => visit(childValue, childKey));
  };
  return visit(body);
}

/**
 * Studio may issue an internal memory-extraction request after a user turn.
 * It is a text-only maintenance request, not another provider rendering of
 * the uploaded user media. Keep it in the wire ledger, but do not require the
 * user-turn media invariant on that request or the UI validator reports a
 * false media-drop failure.
 */
function isInternalMemoryExtraction(provider: HarnessProvider, body: Record<string, unknown>): boolean {
  const visibleContent = conversationContent(provider, body);
  return hasString(visibleContent, (text) =>
    text.includes('You are now acting as the memory extraction subagent') ||
    /^Conversation:\s*/m.test(text),
  );
}

function validateCaseSemantics(provider: HarnessProvider, body: Record<string, unknown>, caseId: string, requestIndex: number): string[] {
  const reasons: string[] = [];
  const mediaCase = caseId === 'HIST-INLINE-01' || caseId.startsWith('WIRE-') || caseId === 'HIST-TOOL-FILE-01' ||
    caseId === 'UI-IMG-01' || caseId === 'UI-PDF-01' || caseId === 'UI-FILE-01';
  if (!isInternalMemoryExtraction(provider, body) && mediaCase && !hasProviderMedia(provider, body) && !hasExplicitDegradation(body)) {
    reasons.push('media-dropped-without-degradation');
  }
  if (caseId === 'HIST-TOOL-01' && requestIndex > 1 && !hasExplicitDegradation(body) && !hasProviderMedia(provider, body)) {
    reasons.push('tool-result-media-dropped-without-degradation');
  }
  if ((caseId === 'DEGRADE-AV-01' || caseId === 'UI-FILE-01') && !hasExplicitDegradation(body) && !hasProviderMedia(provider, body)) {
    reasons.push('unsupported-media-dropped-without-degradation');
  }
  if (caseId === 'NEG-UNKNOWN-01' && !hasString(body, (text) => text.includes('future_secret_blob')) && !hasExplicitDegradation(body)) {
    reasons.push('unknown-ingress-dropped-without-degradation');
  }
  return reasons;
}

export function validateWire(provider: HarnessProvider, body: unknown, requestIndex = 1, caseId = 'unknown'): ValidationResult {
  const reasons = !isRecord(body) ? ['body-not-object'] : [
    ...validateCommon(body, provider),
    ...validateCaseSemantics(provider, body, caseId, requestIndex),
  ];
  return { passed: reasons.length === 0, reasons, provider, requestIndex };
}

function sseFrame(event: string | undefined, data: unknown): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

function streamFor(provider: HarnessProvider, scenario: GatewayOptions['scenario'], requestIndex: number): string {
  const tool = scenario === 'tool' && requestIndex === 1;
  const text = tool ? undefined : 'HARNESS_OK';
  if (provider === 'anthropic-messages') {
    const frames = [sseFrame('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } })];
    if (tool) {
      frames.push(sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'ui_screenshot', input: {} } }));
      frames.push(sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }));
      frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }));
    } else {
      frames.push(sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      frames.push(sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
      frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }));
    }
    frames.push(sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }));
    frames.push(sseFrame('message_stop', { type: 'message_stop' }));
    return frames.join('');
  }
  if (provider === 'openai-compat') {
    const frames = [sseFrame(undefined, { id: 'harness', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })];
    if (tool) {
      frames.push(sseFrame(undefined, { id: 'harness', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'ui_screenshot', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    } else {
      frames.push(sseFrame(undefined, { id: 'harness', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }));
    }
    frames.push(sseFrame(undefined, { id: 'harness', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    return `${frames.join('')}data: [DONE]\n\n`;
  }
  if (provider === 'openai-responses') {
    const frames = [sseFrame('response.created', { type: 'response.created', response: { id: 'harness' } })];
    if (tool) {
      frames.push(sseFrame('response.output_item.added', { type: 'response.output_item.added', item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'ui_screenshot', arguments: '' } }));
      frames.push(sseFrame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{}' }));
      frames.push(sseFrame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: '{}' }));
    } else {
      frames.push(sseFrame('response.output_text.delta', { type: 'response.output_text.delta', delta: text }));
      frames.push(sseFrame('response.output_text.done', { type: 'response.output_text.done' }));
    }
    frames.push(sseFrame('response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }));
    return frames.join('');
  }
  const payload = tool
    ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'ui_screenshot', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }
    : { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
  return sseFrame(undefined, payload);
}

async function persist(record: GatewayRecord, manifest?: string): Promise<void> {
  if (!manifest) return;
  await mkdir(dirname(manifest), { recursive: true });
  const wirePath = manifest.replace(/\.json$/, '.wire.redacted.jsonl');
  const validatorPath = manifest.replace(/\.json$/, '.validator.json');
  await appendFile(wirePath, `${JSON.stringify({ requestIndex: record.requestIndex, path: record.path, wire: record.wire, response: record.response })}\n`);
  await writeFile(validatorPath, JSON.stringify({ provider: record.validator.provider, requests: [record.validator] }, null, 2));
  await writeFile(manifest, JSON.stringify({ caseId: record.headers['x-forgeax-case'], provider: record.validator.provider, requestCount: record.requestIndex, updatedAt: record.receivedAt }, null, 2));
}

export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  if (!PROVIDERS.has(options.provider)) throw new Error(`unsupported provider: ${options.provider}`);
  if (!/^(127\.0\.0\.1|localhost)$/.test(options.host ?? '127.0.0.1')) throw new Error('gateway only binds loopback');
  const records: GatewayRecord[] = [];
  const host = options.host ?? '127.0.0.1';
  const server = Bun.serve({
    hostname: host,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      const expected = {
        'anthropic-messages': '/v1/messages',
        'openai-compat': '/v1/chat/completions',
        'openai-responses': '/v1/responses',
        gemini: /^\/v1beta\/models\/[^/]+:streamGenerateContent$/,
      }[options.provider];
      const pathOk = typeof expected === 'string' ? url.pathname === expected : expected.test(url.pathname);
      if (request.method !== 'POST' || !pathOk) return new Response('gateway path/method rejected', { status: 404 });
      const requestIndex = records.length + 1;
      const receivedCase = request.headers.get('x-forgeax-case') ?? '';
      const receivedTurn = request.headers.get('x-forgeax-turn') ?? '';
      const untaggedUi = options.allowUntaggedUi && !receivedCase && !receivedTurn;
      const caseId = untaggedUi ? options.caseId : receivedCase;
      const turn = untaggedUi ? String(requestIndex) : receivedTurn;
      if ((!untaggedUi && caseId !== options.caseId) || !/^[A-Za-z0-9._-]+$/.test(caseId) || !/^\d+$/.test(turn)) {
        return new Response('gateway case/turn headers rejected', { status: 400 });
      }
      if (requestIndex > (options.maxRequests ?? 32)) return new Response('undeclared turn rejected', { status: 409 });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response('invalid json', { status: 400 });
      }
      const validator = validateWire(options.provider, body, requestIndex, options.caseId);
      const stream = streamFor(options.provider, options.scenario ?? 'text', requestIndex);
      const record: GatewayRecord = {
        requestIndex,
        method: request.method,
        path: url.pathname,
        headers: { 'x-forgeax-case': caseId, 'x-forgeax-turn': turn, ...(untaggedUi ? { 'x-forgeax-untagged-ui': 'true' } : {}) },
        wire: redacted(body),
        response: { status: validator.passed ? 200 : 400, stream: redacted(stream) as string },
        validator,
        receivedAt: new Date().toISOString(),
      };
      records.push(record);
      await persist(record, options.manifest);
      if (!validator.passed) return Response.json({ error: 'wire-validator-rejected', reasons: validator.reasons }, { status: 400 });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': `harness-${requestIndex}` } });
    },
  });
  return {
    url: `http://${host}:${server.port}`,
    records,
    server,
    async close() {
      server.stop(true);
      if (options.manifest) {
        await mkdir(dirname(options.manifest), { recursive: true });
        const validatorPath = options.manifest.replace(/\.json$/, '.validator.json');
        await writeFile(validatorPath, JSON.stringify({
          provider: options.provider,
          passed: records.every((record) => record.validator.passed),
          requests: records.map((record) => record.validator),
        }, null, 2));
        await writeFile(join(dirname(options.manifest), `${options.caseId}.summary.json`), JSON.stringify({ provider: options.provider, records }, null, 2));
      }
    },
  };
}

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? 'true' : (argv[++i] ?? 'true');
  }
  return out;
}

if (import.meta.main) {
  const parsed = args(process.argv.slice(2));
  const provider = parsed.provider as HarnessProvider;
  if (!parsed.port || !parsed.case || !PROVIDERS.has(provider)) {
    console.error('usage: bun gateway.ts --provider <anthropic-messages|openai-compat|openai-responses|gemini> --case <CASE_ID> --port <PORT> [--manifest PATH] [--scenario text|tool] [--allow-untagged-ui]');
    process.exit(2);
  }
  const gateway = await startGateway({
    provider,
    caseId: parsed.case,
    port: Number(parsed.port),
    host: parsed.host,
    manifest: parsed.manifest,
    scenario: parsed.scenario === 'tool' ? 'tool' : 'text',
    maxRequests: parsed['max-requests'] ? Number(parsed['max-requests']) : undefined,
    allowUntaggedUi: parsed['allow-untagged-ui'] === 'true',
  });
  console.log(JSON.stringify({ ready: true, url: gateway.url, provider, caseId: parsed.case }));
  const stop = async () => { await gateway.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
