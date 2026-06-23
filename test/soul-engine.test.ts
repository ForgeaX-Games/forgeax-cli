/**
 * R6 数字生命引擎 单测 —— 覆盖 R6-01/02/04/05/07。
 * 集成项(R6-03/06,真 turn 注入)走 e2e 脚本,不在此。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyAndWrite,
  composeEpisodicRecall,
  composeStableMemory,
  loadAgentRecord,
  readLayeredMemory,
  searchMemory,
  soulMemoryRoot,
  trustForSource,
  writeMemoryEntry,
  findSoulPack,
} from '../src/soul';

let TMP = '';
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'fx-soul-'));
});
afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function freshRoot(name: string): string {
  const root = join(TMP, name, 'memory');
  mkdirSync(root, { recursive: true });
  return root;
}

// ─── R6-04 分层记忆·读 ────────────────────────────────────────────────
describe('R6-04 分层记忆·读', () => {
  test('identity/traits always 载;episodes 仅当前 game', () => {
    const root = freshRoot('read');
    mkdirSync(join(root, 'identity'), { recursive: true });
    mkdirSync(join(root, 'traits'), { recursive: true });
    mkdirSync(join(root, 'episodes', 'skyhop'), { recursive: true });
    mkdirSync(join(root, 'episodes', 'oldworld'), { recursive: true });
    writeFileSync(join(root, 'identity', 'core.md'), 'I am Reia, calm and curious.');
    writeFileSync(join(root, 'traits', 'fav.md'), 'Favorite color is chartreuse.');
    writeFileSync(join(root, 'episodes', 'skyhop', 'e1.md'), 'Built a double-jump in SkyHop.');
    writeFileSync(join(root, 'episodes', 'oldworld', 'e0.md'), 'A past-life dragon quest.');

    const mem = readLayeredMemory({ root, game: 'skyhop' });
    expect(mem.identity.length).toBe(1);
    expect(mem.traits.length).toBe(1);
    // episodes 只取当前 game(skyhop),不含 oldworld
    expect(mem.episodes.length).toBe(1);
    expect(mem.episodes[0].file).toBe('episodes/skyhop/e1.md');
    expect(mem.episodes[0].game).toBe('skyhop');
  });

  test('stable 段含 identity+traits+索引;episodic 段仅当前 game', () => {
    const root = freshRoot('compose');
    writeMemoryEntry({ root }, { tier: 'identity', title: 'Who', text: 'I am Reia.' });
    writeMemoryEntry({ root }, { tier: 'traits', title: 'Color', text: 'Likes chartreuse.' });
    writeMemoryEntry({ root, game: 'skyhop' }, { tier: 'episodes', game: 'skyhop', text: 'Made SkyHop.' });

    const stable = composeStableMemory({ root, game: 'skyhop' });
    expect(stable).toContain('I am Reia.');
    expect(stable).toContain('Likes chartreuse.');
    expect(stable).toContain('Memory Index');
    // 索引会一行点名 episode(让模型知道可 Read),但其**正文 section** 不进 stable 前缀
    expect(stable).not.toContain('## episodes/skyhop/made-skyhop.md');

    const epi = composeEpisodicRecall({ root, game: 'skyhop' });
    expect(epi).toContain('Made SkyHop.');
    expect(epi).toContain('skyhop');
  });
});

// ─── R6-05 分层记忆·写(写时分类 + 索引)─────────────────────────────────
describe('R6-05 分层记忆·写', () => {
  test('写时分类:general→traits / game→episodes;MEMORY.md 索引更新', () => {
    const root = freshRoot('write');
    const ref = { root, game: 'skyhop' };
    const written = classifyAndWrite(ref, [
      { kind: 'general', text: 'User prefers dark mode.', title: 'dark-mode' },
      { kind: 'game', text: 'In SkyHop the player has a grappling hook.', title: 'grapple' },
      { text: 'Player got stuck on level 3.' }, // 无 kind + 有 game → episodes(不污染可移植层)
    ]);
    expect(written[0].tier).toBe('traits');
    expect(written[1].tier).toBe('episodes');
    expect(written[1].game).toBe('skyhop');
    expect(written[2].tier).toBe('episodes');

    // 文件确实落盘
    expect(existsSync(join(root, 'traits', 'dark-mode.md'))).toBe(true);
    expect(existsSync(join(root, 'episodes', 'skyhop', 'grapple.md'))).toBe(true);

    // MEMORY.md 索引每条一行 + 分类标签
    const index = readFileSync(join(root, 'MEMORY.md'), 'utf-8');
    expect(index).toContain('[traits] traits/dark-mode.md');
    expect(index).toContain('[episodes:skyhop] episodes/skyhop/grapple.md');
  });

  test('无 game 且非 general 的事实无处可落 → 跳过(不报错)', () => {
    const root = freshRoot('write-nogame');
    const written = classifyAndWrite({ root }, [{ kind: 'game', text: 'orphan' }]);
    expect(written.length).toBe(0);
  });

  test('文件名冲突自动去重', () => {
    const root = freshRoot('dedupe');
    const a = writeMemoryEntry({ root }, { tier: 'traits', title: 'x', text: 'one' });
    const b = writeMemoryEntry({ root }, { tier: 'traits', title: 'x', text: 'two' });
    expect(a).not.toBe(b);
  });
});

// ─── searchMemory(memory_search 真实后端;含前世 episodes)──────────────
describe('searchMemory 全层检索(含前世)', () => {
  test('命中跨层 + 前世游戏 episodes', () => {
    const root = freshRoot('search');
    writeMemoryEntry({ root }, { tier: 'traits', text: 'The user favorite color is chartreuse.' });
    writeMemoryEntry({ root, game: 'oldworld' }, { tier: 'episodes', game: 'oldworld', text: 'Slew the chartreuse dragon.' });
    writeMemoryEntry({ root, game: 'skyhop' }, { tier: 'episodes', game: 'skyhop', text: 'Unrelated jump tuning.' });

    // 当前 game = skyhop,但检索仍能召回前世 oldworld 的相关条目
    const res = searchMemory({ root, game: 'skyhop' }, 'chartreuse');
    expect(res.matches.length).toBeGreaterThanOrEqual(2);
    const files = res.matches.map((m) => m.file);
    expect(files.some((f) => f.includes('oldworld'))).toBe(true);
  });
});

// ─── R6-02 信任档:路径→档 ──────────────────────────────────────────────
describe('R6-02 trustTier 按来源', () => {
  test('builtin/forge→own;marketplace/user-imported→imported', () => {
    expect(trustForSource('builtin')).toBe('own');
    expect(trustForSource('forge')).toBe('own');
    expect(trustForSource('marketplace')).toBe('imported');
    expect(trustForSource('user-imported')).toBe('imported');
  });
});

// ─── R6-01 加载:原生 soul-pack → AgentRecord ───────────────────────────
describe('R6-01 原生 soul-pack 加载', () => {
  test('user-imported pack → 完整 record;trustTier=imported(忽略 pack 自报 own)', async () => {
    const projectRoot = join(TMP, 'proj-imported');
    const packDir = join(projectRoot, '.forgeax/souls-imported', 'reia');
    mkdirSync(join(packDir, 'persona'), { recursive: true });
    mkdirSync(join(packDir, 'skills', 'greet'), { recursive: true });
    mkdirSync(join(packDir, 'tools'), { recursive: true });
    mkdirSync(join(packDir, 'memory', 'identity'), { recursive: true });
    // pack 自报 trust=own —— 必须被忽略(权威 = 路径 = imported)
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({ id: 'reia', version: '1', trust: 'own' }));
    writeFileSync(join(packDir, 'persona', 'identity.md'), '# Reia\n\nCalm and curious.');
    writeFileSync(join(packDir, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Greet warmly\n---\nSay hi.');
    writeFileSync(join(packDir, 'tools', 'world.json'), JSON.stringify({ name: 'spawn_entity', description: 'Spawn', inputSchema: { type: 'object', properties: {} } }));
    writeFileSync(join(packDir, 'memory', 'identity', 'core.md'), 'I am Reia.');

    const found = findSoulPack('reia', projectRoot);
    expect(found?.source).toBe('user-imported');

    const rec = await loadAgentRecord('reia', { projectRoot, game: 'skyhop' });
    expect(rec.source).toBe('user-imported');
    expect(rec.trustTier).toBe('imported'); // ← 不是 pack 自报的 own
    expect(rec.persona).toContain('Calm and curious.');
    expect(rec.skills.length).toBe(1);
    expect(rec.skills[0].skillId).toBe('greet');
    expect(rec.tools.length).toBe(1);
    expect(rec.tools[0].name).toBe('spawn_entity');
    expect(rec.memory.root).toBe(soulMemoryRoot(projectRoot, 'reia'));
    expect(rec.memory.game).toBe('skyhop');
    // seed:pack 的 memory/ 被重生进运行时根
    expect(existsSync(join(rec.memory.root, 'identity', 'core.md'))).toBe(true);
  });
});

// ─── R6-06 转世/携带:同一 soul 进两个 game,identity/traits 沿用、episodes 隔离 ──
describe('R6-06 转世/携带(跨游戏)', () => {
  test('同一 soul 两个 game:traits 沿用,episodes 按 game 隔离', async () => {
    const projectRoot = join(TMP, 'proj-rebirth');
    // 先把可成长记忆写好:traits(便携)+ 两个 game 各一条 episode。
    const root = soulMemoryRoot(projectRoot, 'wanderer');
    writeMemoryEntry({ root }, { tier: 'traits', title: 'voice', text: 'Speaks in haiku.' });
    writeMemoryEntry({ root, game: 'forest' }, { tier: 'episodes', game: 'forest', text: 'Tamed a fox in Forest.' });
    writeMemoryEntry({ root, game: 'desert' }, { tier: 'episodes', game: 'desert', text: 'Found water in Desert.' });

    const inForest = await loadAgentRecord('wanderer', { projectRoot, game: 'forest' });
    const inDesert = await loadAgentRecord('wanderer', { projectRoot, game: 'desert' });

    // 便携层(traits)沿用:同一 root,两世都读得到 haiku
    const fMem = readLayeredMemory(inForest.memory);
    const dMem = readLayeredMemory(inDesert.memory);
    expect(fMem.traits.some((m) => m.body.includes('haiku'))).toBe(true);
    expect(dMem.traits.some((m) => m.body.includes('haiku'))).toBe(true);

    // episodes 按 game 隔离:forest 世只见 fox,desert 世只见 water
    expect(fMem.episodes.map((m) => m.body).join()).toContain('fox');
    expect(fMem.episodes.map((m) => m.body).join()).not.toContain('water');
    expect(dMem.episodes.map((m) => m.body).join()).toContain('water');
    expect(dMem.episodes.map((m) => m.body).join()).not.toContain('fox');
  });
});

// ─── R6-07 兼容:现状 agent(无原生 pack)仍能加载 ─────────────────────
describe('R6-07 兼容现状 agent', () => {
  test('default(无 pack)→ own/forge record,不报错', async () => {
    const projectRoot = join(TMP, 'proj-default');
    mkdirSync(projectRoot, { recursive: true });
    const rec = await loadAgentRecord('default', { projectRoot });
    expect(rec.source).toBe('forge');
    expect(rec.trustTier).toBe('own');
    expect(rec.memory.root).toBe(soulMemoryRoot(projectRoot, 'default'));
    // 无 pack、无 persona compose(default 跳过)→ 空 persona 但不抛错
    expect(typeof rec.persona).toBe('string');
  });
});
