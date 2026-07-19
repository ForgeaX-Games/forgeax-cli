/**
 * H-03 —— 回退后下一轮喂给模型的历史必须含完整 tool_use/tool_result 对(不再只保文本轮)。
 *
 * 复现:旧路径 rewind reseed 走 Repl.toHistory 有损重建(只保 user 文本 + assistant text
 * block,工具轮从略),模型对「已做过的操作」失忆。修复:rewind reseed 复用 foldFromStore
 * (与 resume 同一条重建路径,吃 H-01 的遮蔽事件),天然产出含工具轮的完整历史 → 消灭双实现。
 *
 * 测法(driver 层真链路):预置一段含工具轮的会话 WAL(turn0 有 tool_use/tool_result,turn1
 * 待回退)→ createAgentDriver(capturing provider)→ driver.rewind(keepUserTurns=1)→ driveTurn
 * → 断言 provider 请求 messages 里出现 tool_use 与 tool_result block(且被回退的 turn1 不在)。
 *
 * Boundary(test 层):相对 import + Bun。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, ProviderMessage, Usage } from '../../src/provider/types';
import { EMPTY_USAGE } from '../../src/provider/types';

const ARGS = { model: 'claude-opus-4-8' } as const;

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'drv-rw-tool-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** 记录每次请求 messages 的 capturing provider(单轮回一条文本 assistant)。 */
function capturingProvider(): { provider: LLMProvider; requests: () => ProviderMessage[][] } {
  const reqs: ProviderMessage[][] = [];
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      reqs.push(req.messages);
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
  return { provider, requests: () => reqs };
}

/** 预置一段含工具轮的会话 WAL(turn0 调 read_file 拿结果;turn1 待回退)。 */
function seedWal(file: string): void {
  const ev = (type: string, payload: unknown) => JSON.stringify({ type, payload, ts: 0 });
  const lines = [
    ev('user_prompt.submit', { prompt: 'turn0-read a file', turn: 0 }),
    ev('assistant.message', {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me read it' },
        { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { file_path: '/x' } },
      ],
    }),
    ev('tool.result', { toolUseId: 'tu-1', toolName: 'read_file', result: 'FILE-CONTENTS-XYZ', isError: false }),
    ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'done reading' }] }),
    ev('user_prompt.submit', { prompt: 'turn1-REWOUND', turn: 1 }),
    ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'a1-rewound' }] }),
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
}

/** 把请求 messages 拍平成可断言的 block 类型/文本串。 */
function shape(messages: ProviderMessage[]): { hasToolUse: boolean; hasToolResult: boolean; text: string } {
  let hasToolUse = false;
  let hasToolResult = false;
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      parts.push(m.content);
      continue;
    }
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') hasToolUse = true;
      if (b.type === 'tool_result') hasToolResult = true;
      if (typeof b.text === 'string') parts.push(b.text);
      if (typeof b.content === 'string') parts.push(b.content);
    }
  }
  return { hasToolUse, hasToolResult, text: parts.join(' | ') };
}

describe('H-03 rewind reseed 保留工具轮', () => {
  test('回退到含工具调用的轮次之后,下一轮请求历史含完整 tool_use/tool_result(且不含被回退轮)', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    const wal = join(sessionsDir, 's1', 'events.jsonl');
    seedWal(wal);
    const { provider, requests } = capturingProvider();
    const host = await buildHostContext({ ...ARGS, sessionsDir, sessionId: 's1' }, provider);
    const driver = createAgentDriver({ ...ARGS, sessionsDir, sessionId: 's1', providerOverride: provider }, host);
    try {
      // 回退:保留第 0 轮(含工具),遮蔽 turn1。hasCode:false(纯对话,不碰 CAS)。
      const r = await driver.rewind({
        msgId: 'x',
        hasCode: false,
        keepUserTurns: 1,
        currentMessages: [],
      });
      expect(r).not.toHaveProperty('error');

      await driver.driveTurn('turn2-continue', () => {});
      const reqs = requests();
      expect(reqs.length).toBeGreaterThanOrEqual(1);
      const s = shape(reqs[reqs.length - 1]);
      // ★ 关键:历史含完整工具轮。
      expect(s.hasToolUse).toBe(true);
      expect(s.hasToolResult).toBe(true);
      expect(s.text).toContain('FILE-CONTENTS-XYZ');
      // 被回退轮不复活。
      expect(s.text).not.toContain('turn1-REWOUND');
      expect(s.text).not.toContain('a1-rewound');
    } finally {
      await driver.dispose();
    }
  });
});
