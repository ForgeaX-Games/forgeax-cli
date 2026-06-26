import { Hono } from 'hono';
import { readFile, writeFile, cp, stat, rm, unlink } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
// Why Bun.Glob and not node:fs/promises#glob: bun 1.3.x's shim of the node
// glob silently won't enter dot-prefixed dirs (`.forgeax/`) regardless of
// any option — patterns like `.forgeax/games/<slug>/**/*.ts` return zero
// matches even when files clearly exist. `Bun.Glob` accepts `{ dot: true }`
// and walks dot-dirs correctly. The server is already bun-only (Bun.serve /
// Bun.spawn / Bun.file in main.ts/files.ts/spawn helpers), so this is
// consistent with the rest of the codebase.
import { Glob } from 'bun';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { assetRoot } from '@forgeax/platform-io';
import { friendlyPath } from '@forgeax/platform-io';
import { getActiveGame, setActiveGame, clearActiveGameIf } from '../api/lib/active-game';
import { findMarketplaceManifest } from './lib/marketplace-manifest';
import { computeAgentNaming, pickPersonName, type AgentNaming } from './lib/agent-naming';
import { getPathManager } from '../fs/path-manager';
import { listAgents } from '../agents/loader';
import { getSessionManager } from '../core/session-manager';
import { getTerminalManager } from '../terminal/manager';
import { BLACKBOARD_KEYS } from '../defaults/blackboard-vars';
import type { FileActivityRecord } from '../ledger/file-activity-ledger';

/**
 * Valid game slug: 2-41 chars, [a-z0-9] first then [a-z0-9-]*. No
 * underscores (projects.ts allows them at the workspace level; games
 * intentionally stricter to keep URL/path/import-specifier ergonomics
 * uniform — e.g. /preview/?slug=<x> + .forgeax/games/<x>/). Exported
 * for tests (cc-game/20).
 */
export const GAME_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/**
 * Detect whether a game dir is an interactive film-game (wb-reel): its
 * `reel/scenarios.json` exists and has a non-empty `activeId` (the author has
 * activated a scenario in the reel workbench). The package endpoint uses this
 * to route packaging to the reel bundler (a standalone film-game site) instead
 * of the 3D engine's build-standalone. Any read/parse failure is treated as
 * "not a reel game" (fall back to the existing ECS packaging path).
 *
 * Exported for tests (workbench-package-reel).
 */
export function isReelGame(gameDir: string): boolean {
  try {
    const p = join(gameDir, 'reel', 'scenarios.json');
    if (!existsSync(p)) return false;
    const db = JSON.parse(readFileSync(p, 'utf-8')) as { activeId?: unknown };
    return typeof db.activeId === 'string' && db.activeId.length > 0;
  } catch {
    return false;
  }
}

/** After scaffold-copying a game template, replace every GUID in all
 *  .pack.json files with fresh crypto.randomUUID() values, maintaining
 *  internal cross-references (refs[]). Without this, every game created
 *  from the same template shares the same GUIDs → pack-guid-collision. */
async function regeneratePackGuids(gameDir: string): Promise<void> {
  const glob = new Glob('**/*.pack.json');
  const packFiles: string[] = [];
  for await (const entry of glob.scan({ cwd: gameDir, absolute: true, dot: true })) {
    if (entry.includes('node_modules')) continue;
    packFiles.push(entry);
  }
  const guidMap = new Map<string, string>();
  const fresh = (old: string): string => {
    let g = guidMap.get(old);
    if (!g) { g = crypto.randomUUID(); guidMap.set(old, g); }
    return g;
  };
  for (const fp of packFiles) {
    try {
      const raw = await readFile(fp, 'utf-8');
      const pack = JSON.parse(raw) as { assets?: { guid: string; refs: string[] }[] };
      if (!Array.isArray(pack.assets)) continue;
      for (const asset of pack.assets) {
        asset.guid = fresh(asset.guid);
        asset.refs = asset.refs.map((r) => fresh(r));
      }
      await writeFile(fp, JSON.stringify(pack, null, 2) + '\n', 'utf-8');
    } catch { /* skip malformed pack files */ }
  }
}

function resolveGameTemplate(projectRoot: string): string | null {
  const userOverride = resolve(projectRoot, '.forgeax/games/_template');
  if (existsSync(userOverride)) return userOverride;
  // Use assetRoot() to locate the builtin template across all platforms/modes
  // (dev source tree, or packaged app). assetRoot() points to the 'packages' level.
  const builtin = resolve(assetRoot(), '..', 'packages', 'engine', 'templates', 'game-default');
  if (existsSync(builtin)) return builtin;
  return null;
}

interface MarketplaceAgent {
  id: string;
  role: string;
  cardName: { zh?: string; en?: string };
  color?: string;
  avatar?: string;
  produces?: string[];
  status?: 'active' | 'placeholder';
  default?: boolean;
}

interface ResolvedFile {
  name: string;
  path: string;
  ico: string;
}

function iconFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) return '📄';
  if (['md'].includes(ext)) return name.includes('pillar') ? '🏛️' : name.includes('design') ? '📐' : name.includes('dialog') || name.includes('narrative') ? '💬' : '📝';
  if (['json'].includes(ext)) return name.includes('manifest') ? '📦' : name.includes('tree') ? '📖' : '⚙️';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return '🖼️';
  if (['spine'].includes(ext) || name.includes('.spine.')) return '🦴';
  if (['mp3', 'wav', 'ogg'].includes(ext)) return '🎵';
  return '📄';
}

function expandTemplates(pattern: string, slug?: string): string {
  // Expand <slug>, <module>, <category>, <id>, <ext>, <doc_dir>, <active_game>.dir
  // Game paths anchor at `.forgeax/games/<slug>/` post-2026-05-13 refactor
  // (was `forgeax/games/<slug>/` when the forgeax submodule was the project root).
  let p = pattern;
  if (slug) p = p.replace(/<slug>/g, slug);
  // Remaining templates → wildcards
  p = p
    .replace(/<doc_dir>/g, slug ? `.forgeax/games/${slug}/design` : '.forgeax/games/*/design')
    .replace(/<active_game>\.dir/g, slug ? `.forgeax/games/${slug}` : '.forgeax/games/*')
    .replace(/<slug>/g, '*')
    .replace(/<module>/g, '*')
    .replace(/<category>/g, '*')
    .replace(/<id>/g, '*')
    .replace(/<ext>/g, '*')
    .replace(/<scene>/g, '*');
  return p;
}

// Defensive resolver guards. Some plugin manifests ship unbounded patterns
// (`**/*.ts`) that aren't anchored to <active_game>.dir; without filtering
// they walk every nested workspace's node_modules and return 60k+ matches
// per agent → 50MB JSON, 7s blocking glob. Skip the noise dirs, and cap
// total matches per agent — the UI renders this as a sidebar list and
// can't reasonably display thousands of files anyway.
const NOISE_RX = /(?:^|\/)(?:node_modules|dist|build|\.git|\.cache|\.forgeax\/cache|\.forgeax\/agenteam-state)(?:\/|$)/;
const MAX_FILES_PER_AGENT = 200;

/** Group ledger records by agent → unique paths (latest write per path).
 *  Returns `{ agentId → ResolvedFile[] }`. agentId here = the **last segment**
 *  of agentPath, matching the manifest agent ids ("iori/suzu" → "suzu",
 *  "root" → "root"). Unknown agents (eg "root" when no manifest entry) are
 *  bucketed under their full path.
 *
 *  This is the SSOT-derived attribution (see [[file-activity-tracking]]) —
 *  uses what an agent actually wrote, not what its produces[] manifest says
 *  it might write. Two agents with overlapping produces no longer both
 *  claim the same file. */
function ledgerFilesByAgent(records: FileActivityRecord[], projectRoot: string): Map<string, ResolvedFile[]> {
  // Most-recent-write wins per path. Walk newest-first (caller passes that
  // order) and keep first-seen.
  const seenPath = new Map<string, { agentId: string; rec: FileActivityRecord }>();
  for (const rec of records) {
    if (rec.op === 'delete') continue; // deleted files don't belong to anyone
    if (seenPath.has(rec.path)) continue;
    const agentId = rec.agentPath.split('/').pop() || rec.agentPath;
    seenPath.set(rec.path, { agentId, rec });
  }
  const out = new Map<string, ResolvedFile[]>();
  for (const { agentId, rec } of seenPath.values()) {
    const rel = rec.path.startsWith(projectRoot + '/') ? rec.path.slice(projectRoot.length + 1) : rec.path;
    if (NOISE_RX.test(rel)) continue;
    const file: ResolvedFile = { name: rel.split('/').pop() ?? rel, path: rel, ico: iconFor(rel.split('/').pop() ?? rel) };
    let bucket = out.get(agentId);
    if (!bucket) { bucket = []; out.set(agentId, bucket); }
    if (bucket.length < MAX_FILES_PER_AGENT) bucket.push(file);
  }
  return out;
}

async function resolveProduces(root: string, patterns: string[], slug?: string): Promise<ResolvedFile[]> {
  const out: ResolvedFile[] = [];
  const seen = new Set<string>();
  outer: for (const raw of patterns) {
    const pattern = expandTemplates(raw, slug);
    try {
      // dot:true so patterns rooted at `.forgeax/games/<slug>/` actually
      // descend (default behavior in Bun.Glob is to skip dot-prefixed dirs).
      const g = new Glob(pattern);
      for await (const match of g.scan({ cwd: root, dot: true })) {
        if (NOISE_RX.test(match)) continue;
        if (seen.has(match)) continue;
        seen.add(match);
        // /api/files expects paths relative to projectRoot. Post-refactor,
        // projectRoot is the studio/instance root and patterns already start
        // with `.forgeax/games/...` — no prefix stripping needed.
        out.push({ name: basename(match), path: match, ico: iconFor(basename(match)) });
        if (out.length >= MAX_FILES_PER_AGENT) break outer;
      }
    } catch (e) {
      // pattern not matchable; skip silently
    }
  }
  return out;
}

async function listAllGames(root: string): Promise<Array<{ slug: string; name: string; mtime: number; fileCount: number }>> {
  /* UI enumeration — reads all game dirs as a flat scan; resolves via projectRoot
   * directly rather than per-slug pm.user().gameDir for O(1) listing. */
  const gamesDir = resolve(root, '.forgeax/games');
  if (!existsSync(gamesDir)) return [];
  const out: Array<{ slug: string; name: string; mtime: number; fileCount: number }> = [];
  try {
    for (const slug of readdirSync(gamesDir)) {
      if (slug.startsWith('.') || slug.startsWith('_')) continue;
      const dir = resolve(gamesDir, slug);
      // Per-entry guard: a dangling symlink (e.g. a games/<slug> link whose
      // target was removed by a submodule sync) makes statSync throw ENOENT.
      // This MUST NOT abort the whole enumeration — a loop-wide try/catch would
      // truncate the list at the first bad entry, silently dropping every game
      // read after it (including the active game). The UI then can't find the
      // active slug in the list and falls back to games[0], previewing the
      // wrong game. Skip the bad entry instead of bailing out.
      let st: ReturnType<typeof statSync>;
      try { st = statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      let name = slug;
      try {
        const m = JSON.parse(readFileSync(resolve(dir, 'forge.json'), 'utf-8') ?? '{}') as { name?: string };
        if (typeof m.name === 'string') name = m.name;
      } catch { /* no forge.json */ }
      let fileCount = 0;
      // Cap at 5000 — UI only shows the count as a badge; saves walking
      // huge node_modules trees a freshly-npm-installed game might carry.
      const fcGlob = new Glob('**/*');
      for await (const _ of fcGlob.scan({ cwd: dir, dot: true })) {
        fileCount++;
        if (fileCount >= 5000) break;
      }
      out.push({ slug, name, mtime: st.mtimeMs, fileCount });
    }
  } catch { /* ignore */ }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * Make every live session's cli follow a newly-active game.
 *
 * The active game is now an explicit, persisted binding (active-game.json).
 * But each *running* session also carries its own `config.defaultDir` slug
 * (drives the native agent's terminal cwd) and a long-lived bash shell whose
 * working directory is "sticky" (cached process + persisted .shell_state/cwd +
 * in-memory blackboard CURRENT_DIR). Recording the new active game alone would
 * only affect *future* sessions; the session the user is actively chatting in
 * would stay glued to the old game's dir. So for each in-memory session we:
 *   1. setDefaultDir(slug)         — persist + hot-reload session.json so a
 *                                    later agent (re)boot resolves the new cwd;
 *   2. repoint blackboard CURRENT_DIR → new game dir for every agent, so the
 *                                    next shell command's initialCwd is correct;
 *   3. reset the agent's sticky terminal so a fresh shell spawns at that cwd.
 *
 * Resident sessions (peek != null) are relocated live (config + blackboard +
 * terminal). Non-resident sessions get only their on-disk defaultDir rewritten
 * (setDefaultDirOnDisk) — no hydration — so their next open() boots in the new
 * active game. Active game is workspace-global: every session follows it.
 */
async function propagateActiveGame(projectRoot: string, slug: string): Promise<void> {
  let gameDir: string;
  try {
    gameDir = getPathManager().user().gameDir(slug);
  } catch {
    return; // invalid slug — nothing to point at
  }
  if (!existsSync(gameDir)) return;

  const sm = getSessionManager();
  const tm = getTerminalManager();
  for (const entry of sm.list()) {
    const session = sm.peek(entry.sid);
    if (!session) {
      // Not resident — no live shell/blackboard to relocate, but we still
      // rewrite the stored defaultDir so the next open() boots its agent in
      // the new active game instead of the slug it was created with. (Active
      // game is workspace-global; every session follows it.)
      try { sm.setDefaultDirOnDisk(entry.sid, slug); } catch { /* skip bad session */ }
      continue;
    }
    try {
      await sm.setDefaultDir(entry.sid, slug);
      for (const node of session.tree.list()) {
        session.blackboard.set(node.path, BLACKBOARD_KEYS.CURRENT_DIR, gameDir, { persist: false });
        await tm.resetAgentCwd(node.path);
      }
    } catch {
      // a single bad session shouldn't block the rest of the propagation
    }
  }
}

export function createWorkbenchRouter(): Hono {
  const router = new Hono();

  // ── GET /active-slug — single-field, low-cost. Polled every 5s by
  // PreviewMode, so it must NOT touch marketplace manifest, listAgents(), or
  // produces[] glob resolution. Just one readdir + statSync per .forgeax/games/.
  router.get('/active-slug', (c) => {
    const projectRoot = defaultProjectRoot();
    return c.json({ activeSlug: getActiveGame(projectRoot) ?? null });
  });

  // ── GET /games — list all games + current ──
  // listAllGames + getActiveGame look under <projectRoot>/.forgeax/games/
  // (post-2026-05-13 refactor: games live in instance-local .forgeax/games/
  // under the studio root, not in the forgeax submodule).
  router.get('/games', async (c) => {
    const projectRoot = defaultProjectRoot();
    const games = await listAllGames(projectRoot);
    const activeSlug = getActiveGame(projectRoot);
    return c.json({ games, activeSlug });
  });

  // ── DELETE /games/:slug — remove a game's whole dir ──
  // Charter P3 (explicit contract): detect symlinks with lstatSync so that
  // DELETE of a symlinked game only removes the link node, never follows
  // into the submodule target. Dangling symlinks (broken links) are also
  // cleaned up — lstatSync sees the link node even when existsSync can't.
  router.delete('/games/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }
    const pm = getPathManager();
    const gameDir = pm.user().gameDir(slug);
    let isSymlink = false;
    try { isSymlink = lstatSync(gameDir).isSymbolicLink(); } catch { /* not found */ }
    if (!isSymlink && !existsSync(gameDir)) return c.json({ error: 'not found' }, 404);
    try {
      if (isSymlink) {
        // Symlinked game (shared-library submodule): only remove the link
        // node, never recurse into the submodule target (charter P3).
        await unlink(gameDir);
      } else {
        await rm(gameDir, { recursive: true, force: true });
      }
      // If the deleted game was the explicitly-pinned active game, drop the
      // binding so getActiveGame re-derives from the remaining games instead of
      // staying pinned to a now-missing dir.
      clearActiveGameIf(defaultProjectRoot(), slug!);
      return c.json({ ok: true, slug });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── /agents response cache for the `?include=files` hot path ──
  // AgentsPanel + WorkbenchMode poll at 4 s with include=files, which walks
  // produces[] globs for ~19 agents per call. Default path (no include=files)
  // is already <2ms and not worth caching. Cache key includes lang + slug +
  // include flag so different callers don't poison each other's view.
  type AgentsResp = { agents: unknown[]; activeSlug: string | undefined };
  const agentsCache = new Map<string, { ts: number; resp: AgentsResp }>();
  const AGENTS_TTL_MS = 2500;
  router.get('/agents', async (c) => {
    const lang = (c.req.query('lang') ?? 'zh') as 'zh' | 'en';
    const pinnedSlug = c.req.query('slug') ?? undefined;
    // `?include=files` opts into per-agent files[] resolution. Default skips
    // it: most callers (PreviewMode, FilesPanel, Composer, agent-role, etc.)
    // only read activeSlug/role/name/avatar, and resolving files was the
    // single largest source of UI slowdown.
    //
    // When include=files AND a sid is given, the response is **ledger-derived**
    // (real attribution from <sid>/file-activity.jsonl). Without sid we fall
    // back to the legacy produces[] glob (intent-based) so the endpoint stays
    // usable on a fresh server with no open session.
    const includeFiles = (c.req.query('include') ?? '').split(',').includes('files');
    const sid = c.req.query('sid') ?? undefined;
    const projectRoot = defaultProjectRoot();

    // Ledger-derived files share the per-agent SSOT — read once per request,
    // bucket-by-agent, then look up at render time. Empty when no sid or the
    // session isn't open.
    let ledgerByAgent: Map<string, ResolvedFile[]> | null = null;
    if (includeFiles && sid) {
      try {
        const session = getSessionManager().peek(sid);
        if (session) {
          const records = session.fileActivity.query({ limit: 1000 });
          ledgerByAgent = ledgerFilesByAgent(records, projectRoot);
        }
      } catch { /* ignore — fall back to glob */ }
    }

    // TTL cache only for include=files (the expensive path). sid + slug both
    // baked in so different sessions/games don't poison each other's view.
    const cacheKey = includeFiles ? `${lang}:${pinnedSlug ?? '_auto'}:${sid ?? '_nosid'}` : null;
    if (cacheKey) {
      const hit = agentsCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < AGENTS_TTL_MS) return c.json(hit.resp);
    }

    const found = findMarketplaceManifest(projectRoot);
    if (!found.path) {
      return c.json({
        agents: [],
        error: 'marketplace/manifest.json not found',
        tried: found.triedFriendly,
      });
    }
    const manifestPath = found.path;
    // Use projectRoot directly as the resolution root — patterns are
    // `.forgeax/games/...` relative to instance/studio root.
    const root = projectRoot;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { agents?: MarketplaceAgent[] };
      const autoSlug = getActiveGame(root);
      const slug = pinnedSlug ?? autoSlug;

      // ADR-0019: 为 legacy manifest.json agents 也注入 avatarRules. 字典 key 是
      // plugin 自报 id (def.id, e.g. "arin"/"iori"). legacy "forge" 视觉上是 Arin
      // → 显式 alias. 其它 legacy id (iori/suzu/kotone/iro/tsumugi/cc-coder) 同名
      // 直接匹配上 plugin agent-iori/agent-suzu/... 因为它们的 def.id 就这么写的.
      const pluginEntries = listAgents();
      type AvatarRulesT = NonNullable<(typeof pluginEntries)[number]['definition']['avatarRules']>;
      const avatarRulesById = new Map<string, AvatarRulesT>();
      for (const e of pluginEntries) {
        if (e.definition.avatarRules) {
          avatarRulesById.set(e.definition.id, e.definition.avatarRules);
        }
      }
      // forge → arin (legacy 主 agent 复用 Arin 立绘).
      const arinRules = avatarRulesById.get('arin');
      if (arinRules && !avatarRulesById.has('forge')) {
        avatarRulesById.set('forge', arinRules);
      }

      // 统一命名「中文职能·英文名」+ 灰字英文职能。card 是 SSOT（plugin 自带
      // cnTitle/enTitle/name）；legacy manifest agent 也按 id 借 plugin card 拼。
      type CardT = (typeof pluginEntries)[number]['definition']['card'];
      const cardById = new Map<string, CardT>();
      for (const e of pluginEntries) cardById.set(e.definition.id, e.definition.card);
      const namingFor = (
        id: string,
        fallbackName: string,
        legacyProfession?: { zh?: string; en?: string },
      ): { naming: AgentNaming; personName?: string } => {
        // forge：legacy-only 编排者，没有 plugin card，合成英文名 Forge。
        if (id === 'forge') {
          return {
            naming: computeAgentNaming({
              personName: 'Forge',
              cnTitle: legacyProfession?.zh ?? '主线制作人',
              enTitle: legacyProfession?.en ?? 'Lead Producer',
              fallback: fallbackName,
            }),
            personName: 'Forge',
          };
        }
        const card = cardById.get(id);
        const cn = card?.cnTitle;
        const pn = cn ? pickPersonName(card?.name) : undefined;
        return {
          naming: computeAgentNaming({
            personName: pn,
            cnTitle: cn,
            enTitle: card?.enTitle,
            fallback: fallbackName,
          }),
          personName: pn,
        };
      };

      const agents = await Promise.all(
        (manifest.agents ?? []).map(async (a) => {
          let files: ResolvedFile[] = [];
          if (includeFiles && a.status !== 'placeholder') {
            // SSOT path: real ledger attribution wins when we have a session.
            // Empty bucket = agent simply hasn't written anything yet → empty
            // list (correct, not "show their produces[]"). Falling back to
            // glob would re-introduce the multi-agent-claiming-same-file bug.
            if (ledgerByAgent) {
              files = ledgerByAgent.get(a.id) ?? [];
            } else {
              files = await resolveProduces(root, a.produces ?? [], slug);
            }
          }
          const ar = avatarRulesById.get(a.id);
          const name = a.cardName[lang] ?? a.cardName.zh ?? a.cardName.en ?? a.id;
          const { naming, personName } = namingFor(a.id, name, a.cardName);
          return {
            id: a.id,
            name,
            ...(personName ? { personName } : {}),
            naming,
            role: a.role,
            color: a.color,
            avatar: a.avatar ?? a.id[0].toUpperCase(),
            ...(ar ? { avatarRules: ar } : {}),
            status: a.status ?? 'active',
            isMain: Boolean(a.default),
            files,
          };
        }),
      );
      // Merge plugin-provided agents (kind=agent in the plugin bus). These
      // come from packages/marketplace/plugins/agent-* manifests, distinct
      // from the legacy peers listed in marketplace/manifest.json above.
      // De-dupe by id so a plugin-defined agent doesn't double up with the
      // hand-curated manifest entry.
      const seenIds = new Set(agents.map((a) => a.id));
      for (const entry of listAgents()) {
        const def = entry.definition;
        if (seenIds.has(def.id)) continue;
        seenIds.add(def.id);
        const cardName = def.card.name;
        const name = typeof cardName === 'string'
          ? cardName
          : (cardName[lang] ?? cardName.zh ?? cardName.en ?? def.id);
        const { naming, personName } = namingFor(def.id, name);
        agents.push({
          id: def.id,
          name,
          ...(personName ? { personName } : {}),
          naming,
          role: def.role,
          color: def.card.color,
          avatar: def.card.avatar ?? def.id[0].toUpperCase(),
          // ADR-0019: WEBM 状态机. 仅当 loader 成功解析 AVATAR.md 时存在.
          ...(def.avatarRules ? { avatarRules: def.avatarRules } : {}),
          status: 'active',
          isMain: false,
          files: !includeFiles
            ? []
            : ledgerByAgent
              ? (ledgerByAgent.get(def.id) ?? [])
              : await resolveProduces(root, def.produces ?? [], slug),
        });
      }
      const resp: AgentsResp = { agents, activeSlug: slug };
      if (cacheKey) agentsCache.set(cacheKey, { ts: Date.now(), resp });
      return c.json(resp);
    } catch (e) {
      return c.json({ agents: [], error: (e as Error).message });
    }
  });

  // ── POST /games — create a new game scaffold (mkdir + forge.json + main.ts) ──
  router.post('/games', async (c) => {
    let body: { slug?: string; name?: string; brief?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const slug = String(body?.slug ?? '').trim();
    if (!GAME_SLUG_RE.test(slug)) {
      return c.json({ error: 'slug must be 2-41 chars lowercase ASCII / digits / hyphens' }, 400);
    }
    const projectRoot = defaultProjectRoot();
    const pm = getPathManager();
    const gameDir = pm.user().gameDir(slug);
    if (existsSync(gameDir)) {
      return c.json({ error: `.forgeax/games/${slug} already exists`, slug }, 409);
    }
    const templateDir = resolveGameTemplate(projectRoot);
    if (!templateDir) {
      return c.json({ error: 'game template not found — expected .forgeax/games/_template/ or packages/engine/templates/game-default/' }, 500);
    }
    try {
      await cp(templateDir, gameDir, { recursive: true });
      // Regenerate all GUIDs in .pack.json files so each game has unique
      // identities (the template's GUIDs are shared across all scaffolded games).
      await regeneratePackGuids(gameDir);
      // Replace id in forge.json
      const manifestPath = join(gameDir, 'forge.json');
      if (existsSync(manifestPath)) {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        parsed.id = slug;
        parsed.name = body.name ?? slug;
        await writeFile(manifestPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      } else {
        await writeFile(manifestPath, JSON.stringify({ id: slug, name: body.name ?? slug, entry: 'main.ts' }, null, 2) + '\n', 'utf-8');
      }
      // FORGE.md — capture optional brief for the agent's later reference
      const memoPath = join(gameDir, 'FORGE.md');
      const memo = `# ${body.name ?? slug}\n\n${body.brief ? body.brief + '\n' : '_(no brief yet — tell Forge what you want to make)_\n'}`;
      await writeFile(memoPath, memo, 'utf-8');
      // A freshly-created game is what the user wants to work on next — record
      // it as the explicit active game and relocate live sessions' cli there,
      // so the agent's shell stops resolving against the previous game.
      setActiveGame(projectRoot, slug);
      await propagateActiveGame(projectRoot, slug);
      return c.json({ ok: true, slug, gameDir: friendlyPath(gameDir) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── POST /games/:slug/activate — make a game the explicit active game ──
  // Called by the TopBar game switcher when the user picks a game. Records the
  // choice (active-game.json) AND relocates every live session's cli into the
  // game dir, so "session 拉起的 cli 的默认工作目录就是对应的激活 game".
  router.post('/games/:slug/activate', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }
    const projectRoot = defaultProjectRoot();
    const gameDir = resolve(projectRoot, '.forgeax/games', slug);
    if (!existsSync(gameDir)) {
      return c.json({ error: `.forgeax/games/${slug} not found`, slug }, 404);
    }
    setActiveGame(projectRoot, slug);
    await propagateActiveGame(projectRoot, slug);
    return c.json({ ok: true, activeSlug: slug });
  });

  // ── POST /games/:slug/verify — build/import preflight (closed-loop check) ──
  // The agent writes the game's main.ts + src/ server-side, but the BUILD (vite
  // import-analysis) + RENDER happen client-side where the agent can't see them
  // — so it can declare "done" on a game whose Preview is actually a red error
  // overlay (e.g. main.ts imports "./src/components" that doesn't exist). This
  // bundles the game's main.ts with Bun.build (engine packages external — we
  // only check the game's OWN import graph), surfacing unresolved imports /
  // missing files / syntax errors deterministically, WITHOUT a browser. The
  // agent MUST call this and reach `ok:true` before claiming the game is done.
  router.post('/games/:slug/verify', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }
    const projectRoot = defaultProjectRoot();
    const gameDir = resolve(projectRoot, '.forgeax/games', slug);
    const mainPath = resolve(gameDir, 'main.ts');
    if (!existsSync(mainPath)) {
      return c.json({ ok: false, errors: [{ message: `main.ts not found at .forgeax/games/${slug}/main.ts — scaffold the game first` }] });
    }
    const rel = (f?: string): string | undefined => (f ? f.replace(`${projectRoot}/`, '') : undefined);
    try {
      // engine packages are resolved by the preview's vite, not here — external
      // them so we only validate the game's own (relative) import graph + syntax.
      const result = await Bun.build({
        entrypoints: [mainPath],
        target: 'browser',
        external: ['@forgeax/*'],
        throw: false,
      });
      const errors: Array<{ file?: string; line?: number; message: string }> = result.logs
        .filter((l) => l.level === 'error')
        .map((l) => ({ file: rel(l.position?.file), line: l.position?.line, message: l.message }));

      // Contract-drift typecheck: Bun.build only resolves the import GRAPH; it
      // transpiles WITHOUT type checking, so cross-file API mismatches (e.g.
      // src/survivor.ts calls `hud.setHp` when src/hud.ts only defines `setHP`)
      // pass build and then crash at runtime as `hud.setHp is not a function`.
      // Fold the @forgeax/engine-project contract gate (crash-class TS codes only)
      // into this required preflight so the agent must fix drift before `ok:true`.
      // Run via its bin (Bun.spawn) so the ~2s compile stays off the event loop
      // and behind a process boundary; skip gracefully if the engine isn't built.
      try {
        const tcBin = resolve(projectRoot, 'packages/engine/packages/engine-project/dist/cli.mjs');
        if (existsSync(tcBin)) {
          const proc = Bun.spawn({
            cmd: [process.execPath || 'bun', tcBin, gameDir, '--json'],
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
          const tc = JSON.parse(out) as {
            ok: boolean;
            diagnostics: Array<{ file?: string; line?: number; code: number; message: string }>;
          };
          for (const d of tc.diagnostics) {
            errors.push({ file: rel(d.file), line: d.line, message: `TS${d.code}: ${d.message}` });
          }
        }
      } catch {
        // typecheck unavailable / output unparseable — don't block delivery on a
        // gate-infra error; the import preflight above still stands.
      }

      return c.json({ ok: result.success && errors.length === 0, errors });
    } catch (e) {
      return c.json({ ok: false, errors: [{ message: (e as Error)?.message ?? String(e) }] });
    }
  });

  // ── POST /games/:slug/package — build a standalone, locally-runnable bundle ──
  // Packages the game at .forgeax/games/<slug>/ into a self-contained static
  // site under .forgeax/exports/<slug>/ (engine runtime + game + assets +
  // shaders + a serve.sh). Runs the engine's export build script via bun.
  router.post('/games/:slug/package', async (c) => {
    const slug = c.req.param('slug');
    if (!GAME_SLUG_RE.test(slug ?? '')) {
      return c.json({ error: 'invalid slug' }, 400);
    }
    const projectRoot = defaultProjectRoot();
    const gameDir = resolve(projectRoot, '.forgeax/games', slug);
    if (!existsSync(gameDir)) {
      return c.json({ error: `.forgeax/games/${slug} not found`, slug }, 404);
    }
    // Route B: 影游(wb-reel)走专用 reel bundler，产物是无需 WebGPU 的独立影游站点；
    // 普通 3D 引擎 game 走既有 build-standalone。检测仅看 reel/scenarios.json 的 activeId。
    const reel = isReelGame(gameDir);
    const buildSrc = resolve(
      projectRoot,
      reel ? 'packages/build/reel-src' : 'packages/build/engine-src',
    );
    const scriptRel = reel ? 'export/build-reel-standalone.ts' : 'export/build-standalone.ts';
    if (!existsSync(resolve(buildSrc, scriptRel))) {
      return c.json(
        {
          error: `export build script not found (packages/build/${reel ? 'reel-src' : 'engine-src'}/${scriptRel})`,
        },
        500,
      );
    }
    const outDir = resolve(projectRoot, '.forgeax/exports', slug);
    const bunBin = process.execPath || 'bun';
    try {
      const proc = Bun.spawn({
        cmd: [bunBin, scriptRel, slug!, outDir],
        cwd: buildSrc,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        return c.json({
          error: 'standalone build failed',
          exitCode: code,
          detail: (stderr || stdout).split('\n').slice(-40).join('\n'),
        }, 500);
      }
      return c.json({
        ok: true,
        slug,
        outDir: friendlyPath(outDir),
        runHint: `cd ${friendlyPath(outDir)} && ./serve.sh   # then open http://localhost:8123`,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── GET /events/recent — recent file activity across .forgeax/games/, with agent attribution ──
  // Polled every 4s by WorkbenchMode.AgentsMainArea ledger panel. Each call
  // glob-walks all agents × all games' produces[] then stat()s every match,
  // so a 2.5s in-memory TTL absorbs ~half the work without any visible lag
  // (UI just shows recently-touched files; sub-3s freshness is invisible).
  // Cache is keyed by lang because agent display name varies. Limit isn't in
  // the key — we cache the unsliced list and slice at response time.
  type LedgerEvent = { name: string; path: string; agentId: string; agentName: string; mtime: number; ico?: string };
  const ledgerCache = new Map<string, { ts: number; events: LedgerEvent[] }>();
  const LEDGER_TTL_MS = 2500;
  router.get('/events/recent', async (c) => {
    const lang = (c.req.query('lang') ?? 'zh') as 'zh' | 'en';
    const limit = Math.min(Number(c.req.query('limit') ?? 30), 100);
    const now = Date.now();
    const cached = ledgerCache.get(lang);
    if (cached && now - cached.ts < LEDGER_TTL_MS) {
      return c.json({ events: cached.events.slice(0, limit) });
    }
    const projectRoot = defaultProjectRoot();
    const manifestPath = findMarketplaceManifest(projectRoot).path;
    const events: LedgerEvent[] = [];
    if (manifestPath) {
      const root = projectRoot;
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { agents?: MarketplaceAgent[] };
        // Ledger spans ALL games — pass undefined so produces glob matches all slugs.
        for (const a of manifest.agents ?? []) {
          if (a.status === 'placeholder') continue;
          const files = await resolveProduces(root, a.produces ?? [], undefined);
          for (const f of files) {
            try {
              const abs = resolve(root, f.path);
              const st = await stat(abs);
              events.push({
                name: f.name, path: f.path, agentId: a.id,
                agentName: a.cardName[lang] ?? a.cardName.zh ?? a.id,
                mtime: st.mtimeMs,
                ico: f.ico,
              });
            } catch { /* skip */ }
          }
        }
      } catch { /* manifest unreadable */ }
    }
    events.sort((a, b) => b.mtime - a.mtime);
    ledgerCache.set(lang, { ts: now, events });
    return c.json({ events: events.slice(0, limit) });
  });

  return router;
}
