/**
 * 20.48 — registerTool 同名覆盖 + toolOrder 不重复。
 *
 * 这是 CapabilityRegistry 的内部不变量,无 loop/wire 显形面 —— 与**已验收**的
 * 20.49(removeTool 清 alias)/ 20.50(assembleToolPool)/ 20.51(mcp__server deny)同级,
 * 后者也是直驱真 CapabilityRegistry(见 test/capability-host.test.ts / capability-cases.test.ts)。
 * 故本点沿用同一「真类直驱」标准补齐(registry 是纯内存索引,无 IO,直驱即真栈)。
 *
 * Boundary: test 层。
 */
import { test, expect, describe } from 'bun:test';
import { CapabilityRegistry } from '../src/capability/registry';
import { buildTool, type AgentTool } from '../src/capability/types';

function tool(name: string, hint?: string): AgentTool {
  return buildTool({
    name,
    searchHint: hint,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async () => ({ data: 'ok' }),
    mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

describe('CapabilityRegistry — registerTool 同名覆盖 (20.48)', () => {
  test('后注册同名者覆盖 toolsByName;toolOrder 不重复 push', () => {
    const reg = new CapabilityRegistry();
    reg.registerTool(tool('Read', 'first'));
    reg.registerTool(tool('Read', 'second'));
    // findTool 取后者(覆盖语义)。
    expect(reg.findTool('Read')?.searchHint).toBe('second');
    // listTools 里只出现一次(toolOrder 首见才 push)。
    const reads = reg.listTools().filter((t) => t.name === 'Read');
    expect(reads.length).toBe(1);
    expect(reads[0].searchHint).toBe('second');
  });
});
