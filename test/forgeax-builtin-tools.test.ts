/**
 * 内置 forgeax 工具(宿主侧实现)单测 —— 锁定 todo 044 的修复:forgeax-core 内核路径下
 * `remember` / `memory_search` / `list_games` 不再返回 "Unknown tool",而是真落盘 / 真检索 /
 * 真列举。感知接地工具(query_world/capture_frame)无 eventBus → 优雅降级 unavailable。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isForgeaxBuiltinTool, runForgeaxBuiltinTool } from '../src/kernel/forgeax-builtin-tools';
import { soulMemoryRoot } from '../src/soul';

let TMP = '';
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'fx-builtin-'));
});
afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe('isForgeaxBuiltinTool', () => {
  test('认得内置工具(memory/echo/ui_*),不认 kit / seam / 未知工具', () => {
    for (const n of ['remember', 'memory_search', 'echo', 'ui_snapshot', 'ui_invoke', 'ui_screenshot']) {
      expect(isForgeaxBuiltinTool(n)).toBe(true);
    }
    // 游戏语义工具已迁产品壳经 HostToolSpec seam 注入(P1-7),不再是编排层内置。
    for (const n of ['list_games', 'query_world', 'capture_frame', 'read_file', 'bash', 'delegate_to_subagent', 'totally_unknown']) {
      expect(isForgeaxBuiltinTool(n)).toBe(false);
    }
  });
});

describe('remember (todo 044 主修复)', () => {
  test('kind:general → 写 traits 层 + 落盘 + 重建索引', async () => {
    const projectRoot = join(TMP, 'p-general');
    const out = (await runForgeaxBuiltinTool('remember', { kind: 'general', title: '喜欢黄色', text: '用户喜欢黄色(暖色调)' }, {
      projectRoot,
      agentId: 'forge',
    })) as { ok: boolean; tier: string; file: string };

    expect(out.ok).toBe(true);
    expect(out.tier).toBe('traits');
    const root = soulMemoryRoot(projectRoot, 'forge');
    expect(existsSync(join(root, out.file))).toBe(true);
    expect(readFileSync(join(root, out.file), 'utf-8')).toContain('用户喜欢黄色');
    // 索引重建,可被 memory_search 召回。
    expect(existsSync(join(root, 'MEMORY.md'))).toBe(true);
  });

  test('空 text → ok:false + error(调用方据此翻 isError)', async () => {
    const out = (await runForgeaxBuiltinTool('remember', { text: '   ' }, {
      projectRoot: join(TMP, 'p-empty'),
      agentId: 'forge',
    })) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('empty');
  });

  test('kind:game 但无 active game → ok:false + error', async () => {
    const out = (await runForgeaxBuiltinTool('remember', { kind: 'game', text: '这一关有 BOSS' }, {
      projectRoot: join(TMP, 'p-nogame'),
      agentId: 'forge',
    })) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('active game');
  });

  test('kind:game + active game → 写 episodes/<game>', async () => {
    const projectRoot = join(TMP, 'p-game');
    const out = (await runForgeaxBuiltinTool('remember', { kind: 'game', text: '关卡 1 是雪地' }, {
      projectRoot,
      agentId: 'forge',
      game: 'spin-cube',
    })) as { ok: boolean; tier: string; game?: string; file: string };
    expect(out.ok).toBe(true);
    expect(out.tier).toBe('episodes');
    expect(out.game).toBe('spin-cube');
    expect(out.file.startsWith('episodes/spin-cube/')).toBe(true);
  });
});

describe('memory_search', () => {
  test('召回 remember 写入的条目', async () => {
    const projectRoot = join(TMP, 'p-search');
    await runForgeaxBuiltinTool('remember', { kind: 'general', text: '用户偏好暖色调配色' }, { projectRoot, agentId: 'forge' });
    const out = (await runForgeaxBuiltinTool('memory_search', { query: '暖色调' }, {
      projectRoot,
      agentId: 'forge',
    })) as { query: string; matches: Array<{ text: string }> };
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches.some((m) => m.text.includes('暖色调'))).toBe(true);
  });
});

describe('ui_* 优雅降级(UI 语义操作层)', () => {
  test('无 eventBus / 无 sid → ui_snapshot/ui_invoke 返回 unavailable(不抛)', async () => {
    const noBus = { projectRoot: join(TMP, 'p-perc'), agentId: 'forge' };
    const snap = (await runForgeaxBuiltinTool('ui_snapshot', {}, noBus)) as { unavailable: boolean };
    expect(snap.unavailable).toBe(true);
    const noSid = { ...noBus, eventBus: { publish: () => {} } };
    const invoke = (await runForgeaxBuiltinTool('ui_invoke', { actionId: 'x' }, noSid)) as {
      unavailable: boolean;
      reason?: string;
    };
    expect(invoke.unavailable).toBe(true);
    expect(String(invoke.reason)).toContain('session');
  });

  test('无 eventBus / 无 sid → ui_screenshot 返回 unavailable(不抛,不转 ContentPart)', async () => {
    const noBus = { projectRoot: join(TMP, 'p-perc'), agentId: 'forge' };
    const shot = (await runForgeaxBuiltinTool('ui_screenshot', {}, noBus)) as { unavailable: boolean };
    expect(shot.unavailable).toBe(true);
    const noSid = { ...noBus, eventBus: { publish: () => {} } };
    const shot2 = (await runForgeaxBuiltinTool('ui_screenshot', {}, noSid)) as { unavailable: boolean };
    expect(shot2.unavailable).toBe(true);
  });
});
