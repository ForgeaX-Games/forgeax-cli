/**
 * Phase C2 — forgeax-native driver tests. Mocks the gateway transport and
 * exercises chat() event ordering, abort plumbing, and health() behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerTransport,
  _resetGateway,
  type LlmTransport,
} from '../src/lib/llm-gateway';
import { _resetDefaultRegistryForTests } from '../src/lib/llm-gateway/registry';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';
import { ForgeaxNativeDriver } from '../src/cli-providers/providers/forgeax-native';
import type { Session, ChatEvent } from '@forgeax/agent-runtime';

const TMP = `/tmp/forgeax-native-driver-${process.pid}`;
const USER_ROOT = join(TMP, 'forgeax-user');

function fakeSession(prompt = ''): Session {
  return {
    instanceId: 'i1',
    thread: { id: 't1', cwd: '/tmp' },
    agent: {
      id: 'iori',
      definition: {
        id: 'iori',
        role: 'planner',
        card: { name: { zh: 'I' }, color: '#fff', avatar: '🤖' },
        personaFile: 'p.md',
        defaultLang: 'zh',
        multiInstance: false,
      },
      systemPrompt: prompt,
      defaultSkills: [],
    },
  };
}

let prevBase: string | undefined;
let prevKey: string | undefined;
let prevAnt: string | undefined;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(USER_ROOT, { recursive: true });
  initPathManager({ userRoot: USER_ROOT });
  _resetDefaultRegistryForTests();

  prevBase = process.env.LITELLM_PROXY_BASE_URL;
  prevKey = process.env.LITELLM_PROXY_KEY;
  prevAnt = process.env.ANTHROPIC_API_KEY;
  // Default to direct-Anthropic mode for the chat-flow tests; specific tests
  // override these when they need proxy-mode or unconfigured-mode behaviour.
  delete process.env.LITELLM_PROXY_BASE_URL;
  delete process.env.LITELLM_PROXY_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  _resetGateway();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (prevBase === undefined) delete process.env.LITELLM_PROXY_BASE_URL;
  else process.env.LITELLM_PROXY_BASE_URL = prevBase;
  if (prevKey === undefined) delete process.env.LITELLM_PROXY_KEY;
  else process.env.LITELLM_PROXY_KEY = prevKey;
  if (prevAnt === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnt;
  _resetGateway();
  _resetDefaultRegistryForTests();
  resetPathManager();
});

function mockTransport(impl: LlmTransport['complete']): void {
  registerTransport({ name: 'litellm', complete: impl });
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('ForgeaxNativeDriver', () => {
  it('identity + selfContained = true', () => {
    const d = new ForgeaxNativeDriver();
    expect(d.id).toBe('forgeax-native');
    expect(d.name).toBe('Forgeax Native');
    expect(d.selfContained).toBe(true);
  });

  it('chat() yields token → usage → done from gateway response', async () => {
    mockTransport(async (req) => ({
      text: 'hello world',
      model: req.model,
      transport: 'litellm',
      latencyMs: 12,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    }));
    const d = new ForgeaxNativeDriver();
    const stream = await d.chat(fakeSession('persona-prompt'), { text: 'hi' });
    const events = await collect(stream);
    expect(events.map((e) => e.kind)).toEqual(['token', 'usage', 'done']);
    expect((events[0] as { kind: 'token'; text: string }).text).toBe('hello world');
    expect((events[1] as { kind: 'usage'; totalTokens: number }).totalTokens).toBe(7);
    expect((events[2] as { kind: 'done'; reason: string }).reason).toBe('end_turn');
  });

  it('chat() forwards system prompt + user text to transport', async () => {
    let captured: { messages?: unknown; model?: string } = {};
    mockTransport(async (req) => {
      captured = { messages: req.messages, model: req.model };
      return { text: '', model: req.model, transport: 'litellm', latencyMs: 1 };
    });
    const d = new ForgeaxNativeDriver();
    const stream = await d.chat(fakeSession('SYSTEM-A'), { text: 'USER-B' });
    await collect(stream);
    expect(captured.messages).toEqual([
      { role: 'system', content: 'SYSTEM-A' },
      { role: 'user', content: 'USER-B' },
    ]);
  });

  it('chat() omits system message when systemPrompt is empty', async () => {
    let captured: unknown;
    mockTransport(async (req) => {
      captured = req.messages;
      return { text: '', model: req.model, transport: 'litellm', latencyMs: 1 };
    });
    const d = new ForgeaxNativeDriver();
    await collect(await d.chat(fakeSession(''), { text: 'just user' }));
    expect(captured).toEqual([{ role: 'user', content: 'just user' }]);
  });

  it('chat() picks model from attachments[].model override', async () => {
    let captured = '';
    mockTransport(async (req) => {
      captured = req.model;
      return { text: '', model: req.model, transport: 'litellm', latencyMs: 1 };
    });
    const d = new ForgeaxNativeDriver();
    await collect(
      await d.chat(fakeSession(), {
        text: 'x',
        attachments: [{ model: 'gpt-5.5' }],
      }),
    );
    expect(captured).toBe('gpt-5.5');
  });

  it('chat() yields error + done(error) when transport throws', async () => {
    mockTransport(async () => {
      throw new Error('upstream-blew-up');
    });
    const d = new ForgeaxNativeDriver();
    const events = await collect(await d.chat(fakeSession(), { text: 'x' }));
    expect(events.map((e) => e.kind)).toEqual(['error', 'done']);
    expect((events[0] as { kind: 'error'; message: string }).message).toContain('upstream-blew-up');
    expect((events[0] as { kind: 'error'; recoverable: boolean }).recoverable).toBe(true);
    expect((events[1] as { kind: 'done'; reason: string }).reason).toBe('error');
  });

  it('chat() reports cancelled when AbortSignal fires', async () => {
    mockTransport(async (_req, _opts) => {
      throw new Error('The operation was aborted');
    });
    const d = new ForgeaxNativeDriver();
    const ctrl = new AbortController();
    ctrl.abort();
    const events = await collect(await d.chat(fakeSession(), { text: 'x', signal: ctrl.signal }));
    const err = events.find((e) => e.kind === 'error') as { recoverable: boolean } | undefined;
    expect(err?.recoverable).toBe(false);
    const done = events.find((e) => e.kind === 'done') as { reason?: string } | undefined;
    expect(done?.reason).toBe('cancelled');
  });

  it('cancel() aborts in-flight transport call', async () => {
    let aborted = false;
    mockTransport((req) => {
      return new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    });
    const d = new ForgeaxNativeDriver();
    const stream = await d.chat(fakeSession(), { text: 'x' });
    const collectP = collect(stream);
    await stream.cancel();
    await collectP;
    expect(aborted).toBe(true);
  });

  it('health() ok with direct-vendor .env (ANTHROPIC_API_KEY for claude-* default)', async () => {
    const d = new ForgeaxNativeDriver();
    const h = await d.health();
    expect(h.ok).toBe(true);
    expect(h.name).toBe('forgeax-native');
    expect(h.detail).toContain('direct');
  });

  it('health() ok in proxy mode (LITELLM_PROXY_*)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LITELLM_PROXY_BASE_URL = 'https://x.test';
    process.env.LITELLM_PROXY_KEY = 'sk-test';
    _resetDefaultRegistryForTests();
    const d = new ForgeaxNativeDriver();
    const h = await d.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('LiteLLM');
  });

  it('health() not ok when nothing configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetDefaultRegistryForTests();
    const d = new ForgeaxNativeDriver();
    const h = await d.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/no api key|not set/i);
  });
});
