/**
 * CORE-CTX 修复单测(上下文/压缩子系统):
 *   - CTX-001:水位 token 计数补 cache_creation(cache-写入轮不再低估 prompt 规模)。
 *   - CTX-005:agent 注入 persistToolResult → 超限 tool 结果落盘,marker 带回读路径。
 *   （CTX-004 压后重挂改由 D-01 的 loop 自取机制承担,单测见 test/post-compact-rehydrate.test.ts。）
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function ctx(tools: AgentTool[], provider: LLMProvider, maxTurns = 16): AgentContext {
  return {
    agentId: 'a1',
    provider,
    config: { systemPromptSlots: [], model: 'm', tools, maxTurns },
    toolContext: {},
  };
}

async function collect(agent: CoreAgent): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) out.push(e);
  return out;
}

// ─── CORE-CTX-001 ───────────────────────────────────────────────────────────
describe('CORE-CTX-001 — 水位 token 计数含 cache_creation', () => {
  function asstEnd(usage: Partial<Usage>): ProviderStreamEvent {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage: { ...EMPTY_USAGE, ...usage } as Usage,
      stopReason: 'end_turn',
    };
  }

  test('cache-写入轮 lastPromptTokens = input + cache_creation + cache_read(经 usageContextRatio 观测)', async () => {
    // 证据轮:input=461, cache_creation=5450, cache_read=0 → 真实 prompt=5911(旧代码只记 461)。
    const provider: LLMProvider = {
      api: 'stub',
      async *stream() {
        yield asstEnd({ inputTokens: 461, cacheCreationInputTokens: 5450, cacheReadInputTokens: 0 });
      },
    };
    const agent = new CoreAgent({ context: ctx([], provider), contextWindow: 200_000 });
    const events = await collect(agent);
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd).toBeDefined();
    if (turnEnd?.type === 'turn_end') {
      // 5911/200000 = 0.029555;旧 bug 会是 461/200000 = 0.002305。
      expect(turnEnd.usageContextRatio).toBeCloseTo(5911 / 200_000, 6);
    }
  });

  test('cache-命中轮同样三者和(read 计入)', async () => {
    const provider: LLMProvider = {
      api: 'stub',
      async *stream() {
        yield asstEnd({ inputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 5600 });
      },
    };
    const agent = new CoreAgent({ context: ctx([], provider), contextWindow: 200_000 });
    const events = await collect(agent);
    const turnEnd = events.find((e) => e.type === 'turn_end');
    if (turnEnd?.type === 'turn_end') {
      expect(turnEnd.usageContextRatio).toBeCloseTo(5900 / 200_000, 6);
    }
  });
});

// ─── CORE-CTX-005 ───────────────────────────────────────────────────────────
describe('CORE-CTX-005 — persistToolResult 落盘 + marker 回读路径', () => {
  const BIG = 'X'.repeat(5_000);

  const bigTool = buildTool({
    name: 'big',
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async () => ({ data: BIG }),
    // toolResultContent 优先取 payload.message → 让预算门作用到大字符串上。
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id, message: BIG }, ts: 0 }),
    maxResultSizeChars: 100, // 远小于 5000 → 必被 head-tail 截断
  });

  function asstToolUse(id: string): ProviderStreamEvent {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'big', input: {} }] },
      usage: EMPTY_USAGE as Usage,
      stopReason: 'tool_use',
    };
  }
  function asstText(text: string): ProviderStreamEvent {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      usage: EMPTY_USAGE as Usage,
      stopReason: 'end_turn',
    };
  }

  test('注入 persist → 截断结果落盘, tool_result content 含 full result at <path>', async () => {
    const captured: ProviderRequest[] = [];
    let call = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: ProviderRequest) {
        captured.push(req);
        if (call++ === 0) yield asstToolUse('call-1');
        else yield asstText('ok');
      },
    };

    const persisted: Array<{ raw: string; toolUseId: string; toolName: string }> = [];
    const agent = new CoreAgent({
      context: ctx([bigTool], provider),
      persistToolResult: (raw, meta) => {
        persisted.push({ raw, ...meta });
        return `/tmp/tool-results/${meta.toolUseId}.txt`;
      },
    });
    await collect(agent);

    // persist 被调用,收到全量 raw + 正确 meta。
    expect(persisted.length).toBe(1);
    expect(persisted[0].raw).toBe(BIG);
    expect(persisted[0].toolUseId).toBe('call-1');
    expect(persisted[0].toolName).toBe('big');

    // 第 2 轮请求携带被截断的 tool_result,marker 含回读路径。
    const secondReq = captured[1];
    const json = JSON.stringify(secondReq.messages);
    expect(json).toContain('full result at /tmp/tool-results/call-1.txt');
    expect(json).toContain('truncated');
  });

  test('不注入 persist → marker 无路径(旧行为,零回归)', async () => {
    const captured: ProviderRequest[] = [];
    let call = 0;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: ProviderRequest) {
        captured.push(req);
        if (call++ === 0) yield asstToolUse('call-1');
        else yield asstText('ok');
      },
    };
    const agent = new CoreAgent({ context: ctx([bigTool], provider) });
    await collect(agent);
    const json = JSON.stringify(captured[1].messages);
    expect(json).toContain('truncated');
    expect(json).not.toContain('full result at');
  });
});
