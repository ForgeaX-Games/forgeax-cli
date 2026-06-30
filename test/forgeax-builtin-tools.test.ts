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
  test('认得 5 个内置工具 + echo,不认 kit / 未知工具', () => {
    for (const n of ['remember', 'memory_search', 'list_games', 'query_world', 'capture_frame', 'echo']) {
      expect(isForgeaxBuiltinTool(n)).toBe(true);
    }
    for (const n of ['read_file', 'bash', 'delegate_to_subagent', 'totally_unknown']) {
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

describe('list_games', () => {
  test('列出 .forgeax/games 下的游戏,过滤 _template / 隐藏', async () => {
    const projectRoot = join(TMP, 'p-games');
    mkdirSync(join(projectRoot, '.forgeax/games/spin-cube'), { recursive: true });
    mkdirSync(join(projectRoot, '.forgeax/games/runner'), { recursive: true });
    mkdirSync(join(projectRoot, '.forgeax/games/_template'), { recursive: true });
    mkdirSync(join(projectRoot, '.forgeax/games/.hidden'), { recursive: true });
    const out = (await runForgeaxBuiltinTool('list_games', {}, { projectRoot, agentId: 'forge' })) as {
      count: number;
      games: string[];
    };
    expect(out.games.sort()).toEqual(['runner', 'spin-cube']);
    expect(out.count).toBe(2);
  });
});

describe('感知接地工具优雅降级', () => {
  test('无 eventBus → query_world/capture_frame 返回 unavailable(不抛)', async () => {
    const ctx = { projectRoot: join(TMP, 'p-perc'), agentId: 'forge' };
    const world = (await runForgeaxBuiltinTool('query_world', { query: 'snapshot' }, ctx)) as { unavailable: boolean };
    const frame = (await runForgeaxBuiltinTool('capture_frame', {}, ctx)) as { unavailable: boolean };
    expect(world.unavailable).toBe(true);
    expect(frame.unavailable).toBe(true);
  });
});
