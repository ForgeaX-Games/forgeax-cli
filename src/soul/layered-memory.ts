/**
 * 分层记忆(R6 §2)—— 纯 FS · 模型驱动检索 · 无 RAG。
 *
 * 存储布局(可写运行时记忆,落用户数据根):
 *   <root>/                       root = `.forgeax/souls/<agentId>/memory`
 *     MEMORY.md                   常驻索引:每条一行(分类 + 摘要)
 *     identity/*.md               T0 魂(always 载)
 *     traits/*.md                 T1 可移植倾向(always 载)
 *     episodes/<game>/*.md        T2 情景(按游戏世界隔离;转世按 game 取)
 *
 * 读(召回):identity+traits always → stable 段;当前 game 的 episodes → 当轮
 *   episodic 段(dynamicSuffix)。前世游戏 episodes 不主动载,靠 `searchMemory`
 *   按需引(memory_search MCP 工具的真实后端)。**有前世的 soul 首次进入新世界**
 *   (今世无 episodes 但他界有)→ `composeReincarnationNotice` 发一段转世唤醒
 *   (身份延续 + 世界更替),与 episodic 召回互斥。
 * 写(最小写入):写时分类(general→traits / game→episodes/<game>;低置信默认
 *   episodes,不污染可移植层)+ 重建 `MEMORY.md` 索引。**一期不建周期 consolidation。**
 *
 * 设计依据:`forgeax-soul-pack-与-lean-v1-规格.md` §2。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LayeredMemoryRef, MemoryFact, MemorySection, MemoryTier } from './types';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** 约定:soul 的可写记忆根。 */
export function soulMemoryRoot(projectRoot: string, agentId: string): string {
  const safe = SLUG_RE.test(agentId) ? agentId : 'default';
  return resolve(projectRoot, '.forgeax/souls', safe, 'memory');
}

function listMd(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'memory.md')
      .sort();
  } catch {
    return [];
  }
}

function readBody(abs: string): string {
  try {
    return readFileSync(abs, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** 读单层(identity/traits)或某 game 的 episodes。 */
function readTier(root: string, tier: MemoryTier, game?: string): MemorySection[] {
  const dir = tier === 'episodes' && game ? join(root, 'episodes', game) : join(root, tier);
  if (tier === 'episodes' && !game) return [];
  const out: MemorySection[] = [];
  for (const f of listMd(dir)) {
    const body = readBody(join(dir, f));
    if (!body) continue;
    const rel = tier === 'episodes' && game ? `episodes/${game}/${f}` : `${tier}/${f}`;
    out.push({ file: rel, body, tier, ...(tier === 'episodes' && game ? { game } : {}) });
  }
  return out;
}

/** 召回读:always identity+traits;episodes 仅当前 game(转世隔离)。 */
export function readLayeredMemory(ref: LayeredMemoryRef): {
  identity: MemorySection[];
  traits: MemorySection[];
  episodes: MemorySection[];
} {
  return {
    identity: readTier(ref.root, 'identity'),
    traits: readTier(ref.root, 'traits'),
    episodes: readTier(ref.root, 'episodes', ref.game),
  };
}

/** MEMORY.md 索引正文(常驻上下文)。无 → ''。 */
export function readMemoryIndex(root: string): string {
  const f = join(root, 'MEMORY.md');
  return existsSync(f) ? readBody(f) : '';
}

/** stable 注入段:identity + traits + 索引头(进 systemPrompt.persona 稳定前缀)。 */
export function composeStableMemory(ref: LayeredMemoryRef): string {
  const { identity, traits } = readLayeredMemory(ref);
  const index = readMemoryIndex(ref.root);
  const blocks: string[] = [];
  if (index) blocks.push(`## Memory Index (MEMORY.md)\n\n${index}`);
  for (const m of [...identity, ...traits]) blocks.push(`## ${m.file}\n\n${m.body}`);
  // drift caveat(对齐 cc MEMORY_DRIFT_CAVEAT):记忆是 point-in-time,用前先核实当前状态。
  const caveat =
    '> These memories are point-in-time observations, not live state. Before asserting a remembered fact ' +
    '(a file/function/flag, or repo state), verify it against the current code; trust what you observe now over a stale memory.';
  return blocks.length ? `# Long-term Memory (identity + traits)\n\n${caveat}\n\n${blocks.join('\n\n')}` : '';
}

/** 当轮 episodic 段:当前 game 的 episodes(进 dynamicSuffix,不进 stable 前缀)。 */
export function composeEpisodicRecall(ref: LayeredMemoryRef): string {
  if (!ref.game) return '';
  const { episodes } = readLayeredMemory(ref);
  if (!episodes.length) return '';
  const blocks = episodes.map((m) => `## ${m.file}\n\n${m.body}`).join('\n\n');
  return `# Episodic Memory · this world (${ref.game})\n\n${blocks}`;
}

/** 列出该 soul 已存有 episodes 的游戏世界 slug(含前世 + 今世),按字典序。 */
function listEpisodeWorlds(root: string): string[] {
  try {
    return readdirSync(join(root, 'episodes'))
      .filter((g) => SLUG_RE.test(g) && listMd(join(root, 'episodes', g)).length > 0)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 转世 L1 唤醒通知(R6 §转世)——当一个**有前世**的 soul 首次进入一个**新世界**
 * (当前 game 尚无 episodes,但其它世界有)时注入。让「identity/traits 跨游戏携带」
 * 在踏入新世界的第一轮就连贯:身份延续,世界更替,前世细节是**可引用的他界上下文,
 * 而非今世事实**(避免把别的游戏的设定当成当前游戏的既定事实)。
 *
 * 触发条件(三者皆需):① `ref.game` 已设;② 当前 game 还没有 episodes(新世界);
 * ③ 存在其它世界的 episodes(确有前世)。否则返回 '':
 *   - 无 game / 新生(全无 episodes)→ 不是转世,是出生。
 *   - 旧地重游(当前 game 已有 episodes)→ 交给 `composeEpisodicRecall`,不发通知。
 * 与 `composeEpisodicRecall` 互斥(一个要求今世 episodes=0,另一个要求 ≥1)。
 */
export function composeReincarnationNotice(ref: LayeredMemoryRef): string {
  if (!ref.game) return '';
  const worlds = listEpisodeWorlds(ref.root);
  if (worlds.includes(ref.game)) return ''; // 旧地重游 → episodic 召回接管
  const pastWorlds = worlds.filter((g) => g !== ref.game);
  if (pastWorlds.length === 0) return ''; // 新生:无前世
  const list = pastWorlds.map((g) => `- \`${g}\``).join('\n');
  return [
    `# Reincarnation · entering a new world (\`${ref.game}\`)`,
    'You carry the **same identity and traits** across every world you live in — they are stated above and apply here unchanged.',
    `But \`${ref.game}\` is **new to you**: you hold no memories *of this world* yet. You have lived in other worlds before:`,
    list,
    `Those past lives are reachable via \`memory_search\`, but they are **context from other worlds — reference them, never assert them as facts about \`${ref.game}\`**. Begin forming fresh episodic memories for this world as you work.`,
  ].join('\n\n');
}

/** 全层扫描(含前世游戏 episodes)的按需检索 —— memory_search 的真实后端。
 *  朴素关键词打分(token 重叠 + 子串),无 RAG(规格:模型驱动 + 纯 FS)。 */
export function searchMemory(
  ref: LayeredMemoryRef,
  query: string,
  limit = 5,
): { query: string; matches: Array<{ tier: MemoryTier; game?: string; file: string; text: string }> } {
  const all: MemorySection[] = [
    ...readTier(ref.root, 'identity'),
    ...readTier(ref.root, 'traits'),
  ];
  // 所有游戏的 episodes(含前世):遍历 episodes/<game>/*。
  const epRoot = join(ref.root, 'episodes');
  try {
    for (const g of readdirSync(epRoot)) {
      if (!SLUG_RE.test(g)) continue;
      all.push(...readTier(ref.root, 'episodes', g));
    }
  } catch {
    /* 无 episodes 目录 → 跳过 */
  }

  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  const scored = all
    .map((m) => {
      const hay = m.body.toLowerCase();
      let score = hay.includes(q) ? 5 : 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    matches: scored.map(({ m }) => ({
      tier: m.tier,
      ...(m.game ? { game: m.game } : {}),
      file: m.file,
      text: m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body,
    })),
  };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'entry'
  );
}

/** 重建 MEMORY.md 索引(扫盘,保证与文件一致;每条一行:`- [tier(:game)] relpath — 摘要`)。 */
function rebuildIndex(root: string): void {
  const lines: string[] = [];
  const add = (sections: MemorySection[]) => {
    for (const m of sections) {
      const first = m.body.split(/\r?\n/).find((l) => l.trim()) ?? '';
      const summary = first.replace(/^#+\s*/, '').slice(0, 120);
      const tag = m.game ? `${m.tier}:${m.game}` : m.tier;
      lines.push(`- [${tag}] ${m.file} — ${summary}`);
    }
  };
  add(readTier(root, 'identity'));
  add(readTier(root, 'traits'));
  const epRoot = join(root, 'episodes');
  try {
    for (const g of readdirSync(epRoot).sort()) {
      if (SLUG_RE.test(g)) add(readTier(root, 'episodes', g));
    }
  } catch {
    /* none */
  }
  const content = `# MEMORY index\n\n> 常驻索引:每条一行。模型据此挑文件 Read 召回(纯 FS,无 RAG)。\n\n${lines.join('\n')}\n`;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'MEMORY.md'), content);
}

/** 写一条记忆到对应层 + 重建索引。返回写入的相对路径。 */
export function writeMemoryEntry(
  ref: LayeredMemoryRef,
  entry: { tier: MemoryTier; game?: string; title?: string; text: string },
): string {
  const tier = entry.tier;
  const game = tier === 'episodes' ? entry.game ?? ref.game : undefined;
  if (tier === 'episodes' && !game) {
    throw new Error('writeMemoryEntry: episodes tier requires a game');
  }
  const dir =
    tier === 'episodes' && game ? join(ref.root, 'episodes', game) : join(ref.root, tier);
  mkdirSync(dir, { recursive: true });

  const base = slugify(entry.title ?? entry.text);
  let name = `${base}.md`;
  let n = 2;
  while (existsSync(join(dir, name))) name = `${base}-${n++}.md`;

  const heading = entry.title ? `# ${entry.title}\n\n` : '';
  writeFileSync(join(dir, name), `${heading}${entry.text.trim()}\n`);

  const rel = tier === 'episodes' && game ? `episodes/${game}/${name}` : `${tier}/${name}`;
  rebuildIndex(ref.root);
  return rel;
}

/** 写时分类(最小写入):general→traits;game→episodes/<game>;无 kind/低置信→episodes
 *  (有 game 时;否则默认进 traits)。返回每条写入的 {tier,game,file}。 */
export function classifyAndWrite(
  ref: LayeredMemoryRef,
  facts: MemoryFact[],
): Array<{ tier: MemoryTier; game?: string; file: string }> {
  const written: Array<{ tier: MemoryTier; game?: string; file: string }> = [];
  for (const f of facts) {
    if (!f.text.trim()) continue;
    // 路由:明确通用 → traits;否则若有当前 game → episodes(低置信默认不污染可移植层)。
    const toTraits = f.kind === 'general' || (f.kind !== 'game' && !ref.game);
    const tier: MemoryTier = toTraits ? 'traits' : 'episodes';
    const game = tier === 'episodes' ? ref.game : undefined;
    if (tier === 'episodes' && !game) continue; // 无 game 又非 general → 无处可落,跳过
    const file = writeMemoryEntry(ref, { tier, game, title: f.title, text: f.text });
    written.push({ tier, ...(game ? { game } : {}), file });
  }
  return written;
}
