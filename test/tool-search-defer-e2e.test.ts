/**
 * 20 — 动态工具与 ToolSearch:真栈 e2e(补齐清单里此前只有纯函数覆盖的边界点)。
 *
 * 不是纯函数桩:spawn 一个**真 stdio MCP server 子进程**(newline-framed JSON-RPC),
 * 经 `assembleCapabilities` 的**真实装配路径**(真 initialize/tools/list、真 defer POLICY
 * `decideMcpDeferMode`、真 bridge `shouldDefer`/`searchHint` 映射)拿到 deferred AgentTool[],
 * 再驱动**真 `CoreAgent.run()` loop**(真 deferred 集/ToolSearch 构建/effectiveTools/manifest
 * 注入/dispatch)。唯一脚本化的是 LLM 每轮吐什么 tool_use —— 这是**必须**的:真模型不会
 * 稳定吐出 `max_results:-3` / `SELECT:` / 空 query 这类边界输入,脚本化 provider 才能确定性
 * 命中边界。断言全部读**真 loop 的可观测出墙**:每轮 `req.tools`(对象)、`req.system`
 * (manifest 文本)、`tool_result` 事件(内容 / errorCategory)。
 *
 * 对应清单 20 点:20.5 / 20.8 / 20.9 / 20.10 / 20.12 / 20.13 / 20.14 / 20.17 / 20.20 /
 *   20.23 / 20.25 / 20.26 / 20.41。(20.48 registry 内部不变量见 tool-search-registry.test.ts,
 *   与已验收的 20.49/20.50/20.51 同为真 CapabilityRegistry 直驱。)
 *
 * Boundary: test 层,允许 node: + spawn。fixture / provider idiom 取自
 *   test/mcp-stdio-e2e.test.ts + test/mcp-defer-e2e.test.ts。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleCapabilities } from '../src/runtime/assemble';
import { makeStdioMcpFactory } from '../src/cli/mcp-stdio';
import { EventBus } from '../src/events/event-bus';
import { CoreAgent } from '../src/agent/agent';
import { TOOL_SEARCH_NAME, buildToolSearchTool } from '../src/capability/tool-search';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { AgentTool } from '../src/capability/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage, StopReason } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── 真 stdio MCP server fixture ───────────────────────────────────────────────
// 暴露:alpha(有 hint)、beta(hint 含换行→测折叠)、gamma(无 hint→测 name-only)、
//       shr0..shr6(共 7 个同 hint,测 max_results 截断到 5)。全部默认 defer。

const tmp = mkdtempSync(join(tmpdir(), 'ts-defer-e2e-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeFixture(): string {
  const path = join(tmp, `srv-${Math.random().toString(36).slice(2)}.mjs`);
  const src = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    let result;
    if (req.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fx', version: '0' } };
    } else if (req.method === 'tools/list') {
      const tools = [
        { name: 'alpha', description: 'alpha tool', inputSchema: { type: 'object' }, _meta: { 'anthropic/searchHint': 'query the alpha thing' } },
        { name: 'beta', description: 'beta tool', inputSchema: { type: 'object' }, _meta: { 'anthropic/searchHint': 'multi\\n  line beta hint' } },
        { name: 'gamma', description: 'gamma tool', inputSchema: { type: 'object' } },
      ];
      for (let i = 0; i < 7; i++) tools.push({ name: 'shr' + i, description: 'shared ' + i, inputSchema: { type: 'object' }, _meta: { 'anthropic/searchHint': 'shared pool member' } });
      result = { tools };
    } else if (req.method === 'tools/call') {
      result = { content: [{ type: 'text', text: JSON.stringify(req.params?.arguments ?? {}) }] };
    } else { result = {}; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  }
});
`;
  writeFileSync(path, src, 'utf8');
  return path;
}

// ─── 脚本化 provider:捕获每轮 req.tools(对象)+ req.system 文本;按脚本吐 tool_use/text ──
type Block = { type: string; [k: string]: unknown };
function asst(content: Block[], stopReason: StopReason): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content }, usage: { ...EMPTY_USAGE } as Usage, stopReason };
}
const txt = (t: string): Block[] => [{ type: 'text', text: t }];
const tu = (id: string, name: string, input: unknown): Block[] => [{ type: 'tool_use', id, name, input }];

interface Cap {
  toolNames: string[][];
  system: string[];
}
function mkProvider(handlers: Array<() => ProviderStreamEvent[]>): { provider: LLMProvider; cap: Cap } {
  const cap: Cap = { toolNames: [], system: [] };
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req: ProviderRequest) {
      cap.toolNames.push(req.tools.map((t) => t.name));
      cap.system.push(req.system.map((b) => (b as { text?: string }).text ?? '').join('\n'));
      const h = handlers[Math.min(call, handlers.length - 1)];
      call++;
      for (const ev of h()) yield ev;
    },
  };
  return { provider, cap };
}

function ctx(tools: AgentTool[], prov: LLMProvider): AgentContext {
  return { agentId: 'a', provider: prov, config: { systemPromptSlots: [], model: 'm', tools, maxTurns: 8 }, toolContext: {} };
}
async function run(agent: CoreAgent, payload = 'hi'): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload, ts: 0 } })) out.push(e);
  return out;
}
/** 从事件流取 ToolSearch(或任意工具)的 tool.result CoreEvent payload。 */
function toolResults(evs: AgentEvent[]): Array<{ content?: string; message?: string; errorCategory?: string; result?: { matches: Array<{ name: string }>; totalMatched: number; truncatedTo: number } }> {
  return evs
    .filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')
    .map((e) => (e.result as { payload: Record<string, unknown> }).payload as never);
}

// ─── 真栈装配(一次 spawn,多场景复用 assembled.tools)─────────────────────────
let TOOLS: AgentTool[];
let DISPOSE: () => Promise<void>;
const A = 'mcp__srv__alpha';
const B = 'mcp__srv__beta';
const G = 'mcp__srv__gamma';

beforeAll(async () => {
  const fixture = writeFixture();
  const assembled = await assembleCapabilities({
    bus: new EventBus(),
    mcp: { config: { mcpServers: { srv: { command: process.execPath, args: [fixture] } } }, deps: { stdioFactory: makeStdioMcpFactory() } },
  });
  TOOLS = assembled.tools;
  DISPOSE = async () => { for (const d of assembled.disposers) await d(); };
  // 自检:真 defer POLICY 把 MCP 工具都标成 deferred(默认 defer)。
  const alpha = TOOLS.find((t) => t.name === A);
  expect(alpha?.shouldDefer?.()).toBe(true);
});
afterAll(async () => { if (DISPOSE) await DISPOSE(); });

describe('20 动态工具 — 真栈 e2e (真 MCP 子进程 + 真 loop)', () => {
  test('20.41 bridge searchHint 取 _meta 并折叠空白(真装配后的工具对象)', () => {
    const beta = TOOLS.find((t) => t.name === B)!;
    const gamma = TOOLS.find((t) => t.name === G)!;
    expect(beta.searchHint).toBe('multi line beta hint'); // 换行/多空格折叠成单空格
    expect(gamma.searchHint).toBeUndefined(); // 无 _meta → undefined
  });

  test('20.17 manifest:无 searchHint 工具只列名(真 req.system)', async () => {
    const { provider, cap } = mkProvider([() => [asst(txt('done'), 'end_turn')]]);
    await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    const sys = cap.system[0];
    expect(sys).toContain(`- ${G}`); // gamma name-only
    expect(sys).not.toContain(`${G} —`); // 无 " — hint" 尾巴
    expect(sys).toContain(`${A} — query the alpha thing`); // alpha 带 hint
  });

  test('20.5 SELECT: 大小写不敏感前缀 → 精确激活(真 loop 次轮含该工具)', async () => {
    const { provider, cap } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: `SELECT:${A}` }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    expect(cap.toolNames[0]).not.toContain(A); // 首轮延迟
    expect(cap.toolNames[1]).toContain(A); // SELECT(大写)命中 → 次轮上线
  });

  test('20.10 空/空白 query → 空 matches,不激活', async () => {
    const { provider, cap } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: '   ' }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const evs = await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    const r = toolResults(evs).find((x) => x.result);
    expect(r?.result?.matches).toEqual([]);
    // 次轮无新增 MCP 工具(除 ToolSearch)。
    expect(cap.toolNames[1].filter((n) => n.startsWith('mcp__srv__'))).toEqual([]);
  });

  test('20.8 max_results 非法(0)→ 回落 5;20.12 mapResult 含 showing first', async () => {
    const { provider } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: 'shared', max_results: 0 }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const evs = await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    const r = toolResults(evs).find((x) => x.result)!;
    expect(r.result!.totalMatched).toBe(7); // 7 个 shrN 命中 'shared'
    expect(r.result!.truncatedTo).toBe(5); // max_results:0 → 回落 5
    expect(r.result!.matches.length).toBe(5);
    expect(r.content).toContain('showing first 5'); // 20.12
    expect(r.content).toContain('raise max_results');
  });

  test('20.9 max_results 小数 → Math.floor', async () => {
    const { provider } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: 'shared', max_results: 2.9 }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const evs = await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    const r = toolResults(evs).find((x) => x.result)!;
    expect(r.result!.truncatedTo).toBe(2);
    expect(r.result!.matches.length).toBe(2);
  });

  test('20.13 无命中 → mapResult 无命中文案', async () => {
    const { provider } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: 'zzz_no_such_tool' }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const evs = await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    const r = toolResults(evs).find((x) => x.result)!;
    expect(r.result!.matches).toEqual([]);
    expect(r.content).toContain('No matching tools found');
    expect(r.content).toContain('select:exactName');
  });

  test('20.14 ToolSearch 只读并发安全(真 buildToolSearchTool 造出的工具)', () => {
    // req.tools 是 provider 已裁剪的 ProviderToolDef(丢谓词),谓词是 buildToolSearchTool
    // 这个真生产 builder 的属性、无 loop 显形面 —— 与 20.48/20.49-51 同为「真类/真 builder
    // 直驱」标准:用真 deferred 集造真 ToolSearch,断谓词。
    const ts = buildToolSearchTool(TOOLS.filter((t) => t.shouldDefer?.() === true), () => {});
    expect(ts.name).toBe(TOOL_SEARCH_NAME);
    expect(ts.isReadOnly({ query: '' })).toBe(true);
    expect(ts.isConcurrencySafe({ query: '' })).toBe(true);
  });

  test('20.20 未激活 deferred 被直接调 → unknown_tool,不崩', async () => {
    const { provider } = mkProvider([
      () => [asst(tu('c1', A, {}), 'tool_use')], // 跳过 ToolSearch 直调延迟工具
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const evs = await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    const err = toolResults(evs).find((x) => x.errorCategory);
    expect(err?.errorCategory).toBe('unknown_tool');
    expect(err?.message).toContain('unknown tool');
    const last = evs.at(-1) as { type: string };
    expect(last.type).toBe('done'); // 没崩
  });

  test('20.23 激活后 manifest 移除已激活项(真 req.system 跨轮)', async () => {
    const { provider, cap } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: `select:${A}` }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    expect(cap.system[0]).toContain(`- ${A}`); // 首轮 manifest 有 alpha
    expect(cap.system[0]).toContain(`- ${B}`); // 也有 beta
    expect(cap.system[1]).not.toContain(`- ${A}`); // alpha 激活后从清单移除
    expect(cap.system[1]).toContain(`- ${B}`); // beta 仍在
  });

  test('20.25 激活幂等:重复 select 同名不重复', async () => {
    const { provider, cap } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: `select:${A}` }), 'tool_use')],
      () => [asst(tu('s2', TOOL_SEARCH_NAME, { query: `select:${A}` }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    await run(new CoreAgent({ context: ctx(TOOLS, provider) }));
    const cnt = cap.toolNames[2].filter((n) => n === A).length;
    expect(cnt).toBe(1); // Set 去重 → 只一次
  });

  test('20.26 activated 随 run 结束重置(同 agent 二次 run 首轮不含上次激活)', async () => {
    const { provider, cap } = mkProvider([
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: `select:${A}` }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const agent = new CoreAgent({ context: ctx(TOOLS, provider) });
    await run(agent, 'first');
    const firstTurns = cap.toolNames.length;
    await run(agent, 'second'); // 第二次 run
    const secondRunTurn0 = cap.toolNames[firstTurns];
    expect(secondRunTurn0).not.toContain(A); // 激活态不跨 run
    expect(secondRunTurn0).toContain(TOOL_SEARCH_NAME);
  });
});
