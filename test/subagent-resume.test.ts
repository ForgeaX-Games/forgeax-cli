/**
 * T6 — subagent resume / 续聊 (hermetic).
 *
 * 覆盖两层:
 *   1. 机制层 `runSubagent`:注入 EventStore ⇒ 子 loop transcript 落盘;fold 回历史作
 *      initialMessages 续跑 ⇒ 第二次子请求 messages[] 含第一次的历史。默认(无 store)零回归。
 *   2. facade `ForgeaxCoreKernel.resumeSubagent`:runTurn 派子(拿唯一 agentId)→ resumeSubagent
 *      续跑 ⇒ 续跑的 provider 请求 messages[] 含派子那轮的历史。
 */
import { test, expect, describe } from 'bun:test';
import { runSubagent } from '../src/agent/subagent';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import { InMemoryEventStore } from '../src/history/event-store';
import { foldFromStore } from '../src/history/llm-fold-adapter';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { EventStore } from '../src/inject/types';
import type { CoreEvent } from '../src/events/types';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}
function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}

/** provider that RECORDS every request's messages and yields scripted events per call. */
function recordingProvider(scripts: ProviderStreamEvent[][]): { provider: LLMProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req: ProviderRequest) {
      requests.push(req);
      const t = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of t) yield ev;
    },
  };
  return { provider, requests };
}

/** serialize a request's messages to a searchable string. */
function messagesText(req: ProviderRequest): string {
  return JSON.stringify(req.messages);
}

async function drainStore(store: EventStore): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  if (store.read) for await (const e of store.read()) out.push(e);
  return out;
}

describe('T6 mechanism — runSubagent persistence + resume seed', () => {
  test('injected EventStore persists child transcript; fold+seed carries history into the 2nd request', async () => {
    const { provider, requests } = recordingProvider([
      [asstText('HALF-DONE [IMPL-T6-mech]')], // run 1: subagent does half
      [asstText('RESUMED [IMPL-T6-mech]')], //   run 2: resumed subagent
    ]);
    const store = new InMemoryEventStore();

    // ── run 1: dispatch a subagent WITH the store injected ──
    const r1 = await runSubagent(
      { input: 'do the first half', agentId: 'subagent:worker:t6', model: 'm', tools: [], eventStore: store },
      { provider },
    );
    expect(r1.agentId).toBe('subagent:worker:t6'); // agentId is returned (T6 additive field)
    expect(r1.text).toContain('HALF-DONE');

    // transcript landed in the store and folds back to a non-empty history.
    const events = await drainStore(store);
    expect(events.length).toBeGreaterThan(0);
    const history = foldFromStore(events);
    expect(history.length).toBeGreaterThanOrEqual(2); // at least the user turn + assistant turn
    const historyText = JSON.stringify(history);
    expect(historyText).toContain('do the first half');
    expect(historyText).toContain('HALF-DONE');

    // ── run 2: resume — fold store → initialMessages, same store injected ──
    const r2 = await runSubagent(
      {
        input: 'continue the second half',
        agentId: 'subagent:worker:t6',
        model: 'm',
        tools: [],
        eventStore: store,
        initialMessages: history,
      },
      { provider },
    );
    expect(r2.text).toContain('RESUMED');

    // ★ core assertion: the 2nd request's messages[] INCLUDES the 1st turn's history.
    const req2 = messagesText(requests[1]);
    expect(req2).toContain('do the first half'); // prior user turn
    expect(req2).toContain('HALF-DONE'); //          prior assistant turn
    expect(req2).toContain('continue the second half'); // + the resume prompt

    // append-only: the store grew (2nd turn appended, not overwritten).
    const eventsAfter = await drainStore(store);
    expect(eventsAfter.length).toBeGreaterThan(events.length);
  });

  test('zero-regression: without eventStore, nothing is persisted', async () => {
    const { provider } = recordingProvider([[asstText('no-store')]]);
    const store = new InMemoryEventStore();
    const r = await runSubagent({ input: 'x', model: 'm', tools: [] }, { provider });
    expect(r.agentId).toBe('subagent'); // default agentId (no unique suffix)
    expect(await drainStore(store)).toHaveLength(0); // untouched
  });
});

describe('T6 facade — ForgeaxCoreKernel.resumeSubagent', () => {
  function req(over: Partial<TurnRequest> = {}): TurnRequest {
    return {
      session: { threadId: 'th', agentId: 'ag' },
      input: { text: 'delegate please' },
      systemPrompt: { charter: 'CHARTER', persona: 'PERSONA' },
      tools: [{ name: 'echo', inputSchema: {} }],
      budget: { maxTurns: 8 },
      ...over,
    };
  }

  test('runTurn dispatches a persisted subagent → resumeSubagent continues with its history', async () => {
    const { provider, requests } = recordingProvider([
      [asstToolUse('tu-1', 'Task', { prompt: 'do the first half', subagent_type: 'worker' })], // 0 parent
      [asstText('HALF-DONE [IMPL-T6-facade]')], //                                              1 subagent
      [asstText('delegated; subagent finished half')], //                                       2 parent final
      [asstText('RESUMED-DONE [IMPL-T6-facade]')], //                                            3 subagent resume
    ]);
    // per-agentId in-memory store factory (host would derive a JsonlFileEventStore path).
    const stores = new Map<string, InMemoryEventStore>();
    const subagentStore = (agentId: string): EventStore => {
      let s = stores.get(agentId);
      if (!s) {
        s = new InMemoryEventStore();
        stores.set(agentId, s);
      }
      return s;
    };

    const kernel = new ForgeaxCoreKernel({ provider, executeTool: async () => null, subagentStore });

    // ── drive one turn; capture the subagent's stable agentId from x.subagent.start ──
    let agentId: string | undefined;
    for await (const ev of kernel.runTurn(req(), new AbortController().signal)) {
      if (ev.kind === 'x.subagent.start') agentId = ev.agentId;
    }
    expect(agentId).toBeDefined();
    expect(agentId!).toContain('subagent:worker:'); // unique persisted id (has suffix)
    expect(stores.has(agentId!)).toBe(true); // transcript persisted under that id

    // ── resume the subagent by its agentId ──
    const resumed: KernelEvent[] = [];
    for await (const ev of kernel.resumeSubagent(agentId!, 'continue the second half', new AbortController().signal)) {
      resumed.push(ev);
    }
    const kinds = resumed.map((e) => e.kind);
    expect(kinds).toContain('turn.done');
    const done = resumed.find((e) => e.kind === 'turn.done');
    expect(done && done.kind === 'turn.done' && done.reason).toBe('stop');
    const msg = resumed.find((e) => e.kind === 'message.delta');
    expect(msg && msg.kind === 'message.delta' && msg.text).toContain('RESUMED-DONE');

    // ★ core assertion: the resume request (call #3) carries the 1st subagent turn's history.
    const resumeReq = messagesText(requests[3]);
    expect(resumeReq).toContain('do the first half'); // prior user turn
    expect(resumeReq).toContain('HALF-DONE'); //          prior assistant turn
    expect(resumeReq).toContain('continue the second half'); // + resume prompt
  });

  test('resumeSubagent with no persisted history → error + turn.done{error}', async () => {
    const { provider } = recordingProvider([[asstText('unused')]]);
    const stores = new Map<string, InMemoryEventStore>();
    const kernel = new ForgeaxCoreKernel({
      provider,
      executeTool: async () => null,
      subagentStore: (id) => {
        let s = stores.get(id);
        if (!s) {
          s = new InMemoryEventStore();
          stores.set(id, s);
        }
        return s;
      },
    });
    const out: KernelEvent[] = [];
    for await (const ev of kernel.resumeSubagent('subagent:ghost', 'hi', new AbortController().signal)) out.push(ev);
    expect(out.some((e) => e.kind === 'error')).toBe(true);
    const done = out.find((e) => e.kind === 'turn.done');
    expect(done && done.kind === 'turn.done' && done.reason).toBe('error');
  });

  test('zero-regression: no subagentStore → resumeSubagent reports unavailable, subagent stays in-memory', async () => {
    const { provider } = recordingProvider([
      [asstToolUse('tu-1', 'Task', { prompt: 'work', subagent_type: 'worker' })],
      [asstText('done')],
      [asstText('final')],
    ]);
    const kernel = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    let startId: string | undefined;
    for await (const ev of kernel.runTurn(req(), new AbortController().signal)) {
      if (ev.kind === 'x.subagent.start') startId = ev.agentId;
    }
    // default (no store) ⇒ stable non-unique id (byte-for-byte legacy behavior).
    expect(startId).toBe('subagent:worker');
    const out: KernelEvent[] = [];
    for await (const ev of kernel.resumeSubagent('subagent:worker', 'x', new AbortController().signal)) out.push(ev);
    expect(out.some((e) => e.kind === 'error' && e.error.code === 'kernel_unavailable')).toBe(true);
  });
});
