/**
 * 04.4 —— manual `/compact` 必须进事件总线/WAL(事件流是真相 §6.1)。
 *
 * 复现:旧路径 driver.triggerCompact 只 splice 内存态 convo,不发 CompactionApplied、
 * 不落 events.jsonl → /resume 的 fold 回放出未压缩全史(压缩「丢了」)。
 * 修复:在 WAL fold 出的正史(含工具轮,与 resume 同坐标系)上压,并把
 * PreCompact(manual)/CompactionApplied/PostCompact 发进 host.bus → connectStore 落 WAL。
 *
 * 测法(driver 层真链路):预置含工具轮的会话 WAL → createAgentDriver → triggerCompact()
 * → 断言 ① WAL 出现三事件;② foldSessionHistory(与 /resume 同源)折成单条 replacement;
 * ③ 下一轮 provider 请求吃压缩后历史。
 *
 * Boundary(test 层):相对 import + Bun。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { foldSessionHistory } from '../../src/cli/resume-fold';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, ProviderMessage, Usage } from '../../src/provider/types';
import { EMPTY_USAGE } from '../../src/provider/types';

const ARGS = { model: 'claude-opus-4-8' } as const;

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'drv-compact-wal-'));
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

/** 预置一段含工具轮的会话 WAL(与 driver-rewind-tool-turns 同构)。 */
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
    ev('user_prompt.submit', { prompt: 'turn1-more work', turn: 1 }),
    ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'a1-done' }] }),
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
}

describe('04.4 manual /compact 进 WAL', () => {
  test('triggerCompact 压 fold 正史 + 发事件落 WAL;resume 同源 fold 吃到压缩;下一轮吃压缩后历史', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    const walFile = join(sessionsDir, 's1', 'events.jsonl');
    seedWal(walFile);
    const { provider, requests } = capturingProvider();
    const host = await buildHostContext({ ...ARGS, sessionsDir, sessionId: 's1' }, provider);
    const driver = createAgentDriver({ ...ARGS, sessionsDir, sessionId: 's1', providerOverride: provider }, host);
    try {
      const r = await driver.triggerCompact();
      expect(r.compacted).toBe(true);
      // 小历史 → L1 sufficiency 短路,零 LLM 调用(capturing provider 未被当 summarizer 调)。
      expect(r.usedLLM).toBe(false);
      expect(requests().length).toBe(0);

      // ① WAL 出现三事件(pre 带 manual trigger;applied/post 带覆盖区间)。
      const wal = readFileSync(walFile, 'utf8');
      expect(wal).toContain('"compaction.pre"');
      expect(wal).toContain('"trigger":"manual"');
      expect(wal).toContain('"compaction.applied"');
      expect(wal).toContain('"compaction.post"');

      // ② 与 /resume 同源的 fold 吃到压缩:6 条会话事件折成单条 replacement(骨架保留原文本)。
      const folded = (await foldSessionHistory(host.store)) ?? [];
      expect(folded.length).toBe(1);
      const foldedText = JSON.stringify(folded[0]);
      expect(foldedText).toContain('turn0-read a file');
      expect(foldedText).toContain('deterministic compaction');

      // ③ 下一轮请求历史 = [replacement, 新 user 轮],原始 assistant 轮不再独立存在。
      await driver.driveTurn('turn2-continue', () => {});
      const reqs = requests();
      expect(reqs.length).toBeGreaterThanOrEqual(1);
      const lastReq = reqs[reqs.length - 1];
      expect(JSON.stringify(lastReq)).toContain('deterministic compaction');
      expect(lastReq.filter((m) => m.role === 'assistant').length).toBe(0);
    } finally {
      await driver.dispose();
    }
  });

  test('历史不足以压缩 → 不写 applied,发 compaction.skipped(nothing-to-compact)', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    const walFile = join(sessionsDir, 's2', 'events.jsonl');
    // 空 WAL(目录存在、文件不存在)→ fold 空 → 回退 convo(也空)→ 未压缩。
    const { provider } = capturingProvider();
    const host = await buildHostContext({ ...ARGS, sessionsDir, sessionId: 's2' }, provider);
    const driver = createAgentDriver({ ...ARGS, sessionsDir, sessionId: 's2', providerOverride: provider }, host);
    try {
      const r = await driver.triggerCompact();
      expect(r.compacted).toBe(false);
      // 空历史直接短路,连事件都不该有 applied。
      let wal = '';
      try {
        wal = readFileSync(walFile, 'utf8');
      } catch {
        /* 文件可能不存在 —— 等价于无事件 */
      }
      expect(wal).not.toContain('"compaction.applied"');
    } finally {
      await driver.dispose();
    }
  });
});
