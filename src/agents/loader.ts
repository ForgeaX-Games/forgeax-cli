/**
 * Phase B5 — AgentLoader (minimal).
 *
 * Reads the kind registry built in B2/B3 and exposes:
 *   - listAgents()              — directory of registered agents
 *   - lookupAgent(id)           — by agent.id (e.g. "cc-coder")
 *   - resolveSkill(ref)         — turn a SkillRef into a SkillEntry
 *   - composeSystemPrompt(id)   — persona md + (optional) default skill
 *                                 prompt sections, per agent
 *
 * Skill execution still lives in Phase D (SkillRunner). Today this loader
 * is consulted by the chat boot path so the right system prompt lands in
 * the LLM call regardless of which CLI provider drives the conversation.
 *
 * See docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.2/§2.3.
 */
import { existsSync, statSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import type { SkillRef } from '@forgeax/types';
import { pickI18n } from '@forgeax/types';
import type { AgentEntry, SkillEntry } from '../plugins/kinds';
import { getPluginSnapshot } from '../plugins/registry';
import { defaultProjectRoot } from '../api/lib/safe-path';
import { assetRoot } from '../lib/asset-root';

export interface ComposedSystemPrompt {
  agentId: string;
  pluginId: string;
  persona: string;
  /** Concatenated `## Skill: <id>\n<body>` blocks for prompt-kind skills only. */
  skillSections: Array<{ skillId: string; pluginId: string; body: string }>;
  /** Per-agent skill index — every defaultSkills entry surfaced as `name —
   *  description`, regardless of entry kind. Prompt-kind skills additionally
   *  show up inline in `skillSections` (full body); ts/py-kind skills only
   *  appear here so the agent knows the tool exists. */
  skillIndex: Array<{ skillId: string; pluginId: string; kind: string; description: string }>;
  /** Concatenated memory file contents (every *.md under AgentDefinition.memoryDir),
   *  keyed by file basename so the LLM can cite which file it's quoting from. */
  memorySections: Array<{ file: string; body: string }>;
  /** Combined string (persona + skill index + skills + memory). */
  text: string;
  warnings: string[];
}

export function listAgents(): AgentEntry[] {
  return getPluginSnapshot().kinds.agents.slice();
}

export function lookupAgent(agentId: string): AgentEntry | null {
  const snap = getPluginSnapshot();
  return snap.kinds.agents.find((a) => a.definition.id === agentId) ?? null;
}

/** Return the skill registry entry that a SkillRef points at, or null
 *  if the ref doesn't resolve. inline-source refs only match within the
 *  same plugin (B5 enforces the simple cases; the cross-plugin
 *  `@scope/name#skillId` form lands when SkillRunner gets implemented). */
export function resolveSkill(
  ref: SkillRef,
  contextPluginId?: string,
): SkillEntry | null {
  const snap = getPluginSnapshot();
  if (ref.source === 'plugin') {
    return snap.kinds.skills.find(
      (s) => s.pluginId === ref.pluginId && (!ref.skillId || s.definition.id === ref.skillId),
    ) ?? null;
  }
  // inline: same plugin as caller
  if (!contextPluginId) return null;
  return snap.kinds.skills.find(
    (s) => s.pluginId === contextPluginId && s.definition.id === ref.skillId,
  ) ?? null;
}

/** Read persona file + any prompt-kind default skills, concatenate into a
 *  single system prompt string. Falls back gracefully when files are
 *  missing — the agent still gets a usable (if shorter) prompt and a
 *  warning is recorded. */
export async function composeSystemPrompt(agentId: string): Promise<ComposedSystemPrompt | null> {
  const entry = lookupAgent(agentId);
  if (!entry) {
    // Fallback: legacy peers in packages/marketplace/manifest.json that haven't
    // been migrated to plugin scaffolds yet (kotone, iro, tsumugi, cc-coder,
    // forge, iori, suzu). Read marketplace.json + peerFile/personaFiles so
    // those agents still produce a persona prompt.
    return composeFromMarketplaceManifest(agentId);
  }
  const warnings: string[] = [];

  let persona = '';
  try {
    persona = await readFile(entry.personaPath, 'utf-8');
  } catch (e) {
    warnings.push(`persona file unreadable: ${(e as Error).message}`);
  }

  const sections: ComposedSystemPrompt['skillSections'] = [];
  const skillIndex: ComposedSystemPrompt['skillIndex'] = [];
  const refs = entry.definition.defaultSkills ?? [];
  for (const r of refs as SkillRef[]) {
    const skill = resolveSkill(r, entry.pluginId);
    if (!skill) {
      warnings.push(`defaultSkill ref unresolved: ${JSON.stringify(r)}`);
      continue;
    }
    const sd = skill.definition;
    let description =
      pickI18n(sd.description, entry.definition.defaultLang ?? 'zh') ||
      pickI18n(sd.displayName, entry.definition.defaultLang ?? 'zh') ||
      '';
    // Prompt-kind skills also get their full body inlined; ts/py skills stay
    // index-only — the agent still knows they exist via the skill listing
    // above and invokes them through the `skill` tool at runtime.
    if (sd.entry.kind === 'prompt') {
      const pluginDir = pluginDirOf(skill.pluginId);
      if (!pluginDir) {
        warnings.push(`cannot resolve plugin dir for skill ${sd.id}`);
      } else {
        const absolute = resolveSkillFile(pluginDir, sd.entry.file);
        try {
          const raw = await readFile(absolute, 'utf-8');
          // agentskills.io: SKILL.md has YAML frontmatter (name+description).
          // Strip before injection (LLM doesn't need the YAML metadata) and
          // prefer frontmatter description when manifest didn't supply one.
          const fm = parseSkillFrontmatter(raw);
          if (!description && fm.description) description = fm.description;
          sections.push({ skillId: sd.id, pluginId: skill.pluginId, body: fm.body });
        } catch (e) {
          warnings.push(`skill file unreadable (${absolute}): ${(e as Error).message}`);
        }
      }
    }
    skillIndex.push({
      skillId: sd.id,
      pluginId: skill.pluginId,
      kind: sd.entry.kind,
      description,
    });
  }

  // Long-term memory: every *.md under the plugin's memoryDir gets pulled in
  // wholesale. Forgeax has no auto-write/compaction on memory yet — files
  // are author-curated lessons / conventions / preferences, so size stays
  // small in practice. If a plugin author wants tiered memory, they split
  // by file (lessons.md / conventions.md / …).
  const memorySections: ComposedSystemPrompt['memorySections'] = [];
  if (entry.definition.memoryDir) {
    const pluginDir = pluginDirOf(entry.pluginId);
    if (pluginDir) {
      const memDirAbs = resolveMemoryDir(pluginDir, entry.definition.memoryDir);
      const loaded = await loadMemoryDir(memDirAbs, warnings);
      memorySections.push(...loaded);
    } else {
      warnings.push(`cannot resolve plugin dir for memoryDir of ${entry.pluginId}`);
    }
  }

  const skillIndexBlock = skillIndex.length > 0
    ? `# Your Skills\n\n${skillIndex.map((s) =>
        `- \`${s.skillId}\` (${s.kind})${s.description ? ` — ${s.description}` : ''}`,
      ).join('\n')}\n\nInvoke ts/py skills via the \`skill\` tool; prompt skills are inlined above.`
    : '';
  const skillBlocks = sections
    .map((s) => `## Skill: ${s.skillId}\n\n${s.body.trim()}`)
    .join('\n\n');
  const memoryBlock = memorySections.length > 0
    ? `# Long-term Memory\n\n${memorySections.map((m) =>
        `## ${m.file}\n\n${m.body.trim()}`,
      ).join('\n\n')}`
    : '';
  const text = [persona.trim(), skillIndexBlock, skillBlocks, memoryBlock]
    .filter((s) => s.length > 0)
    .join('\n\n---\n\n');

  return {
    agentId,
    pluginId: entry.pluginId,
    persona,
    skillSections: sections,
    skillIndex,
    memorySections,
    text,
    warnings,
  };
}

/** Strip an agentskills.io-style YAML frontmatter block from a SKILL.md body.
 *  Returns just the markdown content; the frontmatter is metadata for the
 *  loader, not for the LLM. We do a minimal parse — no YAML lib — because
 *  the spec only has two fields (`name`, `description`) and the frontmatter
 *  is delimited by `---\\n` on its own line.
 *
 *  Also surfaces parsed `name`/`description` so callers can prefer the
 *  frontmatter over a possibly-stale manifest mirror (SSOT on disk). */
export function parseSkillFrontmatter(raw: string): {
  body: string;
  name?: string;
  description?: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: raw };
  const body = raw.slice(m[0].length);
  const block = m[1];
  let name: string | undefined;
  let description: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (kv[1] === 'name') name = v;
    else description = v;
  }
  return { body, name, description };
}

function resolveMemoryDir(pluginDir: string, raw: string): string {
  if (raw.startsWith('/')) return raw;
  return resolve(pluginDir, raw);
}

async function loadMemoryDir(
  absDir: string,
  warnings: string[],
): Promise<Array<{ file: string; body: string }>> {
  if (!existsSync(absDir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir);
  } catch (e) {
    warnings.push(`memoryDir unreadable (${absDir}): ${(e as Error).message}`);
    return [];
  }
  const mds = entries.filter((f) => f.toLowerCase().endsWith('.md')).sort();
  const out: Array<{ file: string; body: string }> = [];
  for (const f of mds) {
    const abs = join(absDir, f);
    try {
      const body = await readFile(abs, 'utf-8');
      const trimmed = body.trim();
      if (trimmed) out.push({ file: basename(f), body: trimmed });
    } catch (e) {
      warnings.push(`memory file unreadable (${abs}): ${(e as Error).message}`);
    }
  }
  return out;
}

interface MarketplaceManifestAgent {
  id: string;
  role?: string;
  peerFile?: string;
  personaFiles?: { zh?: string; en?: string };
}

// Memoize: marketplace location does not change without a server restart, and
// composeSystemPrompt / resolvePersonaForAgent both call this on every chat
// session boot. Without the cache that's 5 existsSync probes per boot, twice
// (manifest and persona resolution paths).
let _mpRootCache: { root: string; result: string | null } | null = null;
function findMarketplaceRoot(): string | null {
  const root = defaultProjectRoot();
  if (_mpRootCache && _mpRootCache.root === root) return _mpRootCache.result;
  const candidates = [
    // Host-bundled marketplace root (has manifest.json). assetRoot() = `packages/`
    // in dev, `<Resources>/resources/` in the packaged .app. Without this the
    // packaged build can't find the marketplace → agent persona/skill
    // composition silently degrades.
    resolve(assetRoot(), 'marketplace'),
    resolve(root, 'packages/marketplace'),
    resolve(root, '../packages/marketplace'),
    resolve(root, '../../packages/marketplace'),
    resolve(root, 'marketplace'),
    resolve(root, '../marketplace'),
  ];
  const result = candidates.find((p) => existsSync(join(p, 'manifest.json'))) ?? null;
  _mpRootCache = { root, result };
  return result;
}

// Manifest cache keyed by absolute path + mtime — invalidates automatically
// when the marketplace submodule is updated (mtime bump on disk). Both
// composeFromMarketplaceManifest and resolvePersonaForAgent shared a parse
// previously, so two independent reads per boot. With the cache they share.
interface MarketplaceManifest { agents?: MarketplaceManifestAgent[] }
const _manifestCache = new Map<string, { mtime: number; parsed: MarketplaceManifest }>();
async function readMarketplaceManifest(mpRoot: string): Promise<MarketplaceManifest | null> {
  const path = join(mpRoot, 'manifest.json');
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { return null; }
  const hit = _manifestCache.get(path);
  if (hit && hit.mtime === mtime) return hit.parsed;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as MarketplaceManifest;
    _manifestCache.set(path, { mtime, parsed });
    return parsed;
  } catch {
    return null;
  }
}

async function composeFromMarketplaceManifest(agentId: string): Promise<ComposedSystemPrompt | null> {
  const mpRoot = findMarketplaceRoot();
  if (!mpRoot) return null;
  const manifest = await readMarketplaceManifest(mpRoot);
  if (!manifest) return null;
  const a = (manifest.agents ?? []).find((x) => x.id === agentId);
  if (!a) return null;
  const personaRel = a.peerFile ?? a.personaFiles?.zh ?? a.personaFiles?.en;
  if (!personaRel) return null;
  let persona = '';
  const warnings: string[] = [];
  try {
    persona = await readFile(join(mpRoot, personaRel), 'utf-8');
  } catch (e) {
    warnings.push(`persona file unreadable: ${(e as Error).message}`);
    return null;
  }
  return {
    agentId,
    pluginId: 'marketplace:legacy',
    persona,
    skillSections: [],
    skillIndex: [],
    memorySections: [],
    text: persona.trim(),
    warnings,
  };
}

/** Resolve `agentId` (marketplace persona / plugin agent id) → absolute
 *  persona-file path. Used by /api/sessions/:sid/messages auto-scaffolding
 *  to pre-populate `agent.json::personaFile` so the persona slot kit can
 *  surface the persona on first turn. Returns null if the id isn't a known
 *  plugin agent and isn't in marketplace/manifest.json (caller should fall
 *  through to the plain "route to root" path). */
export async function resolvePersonaForAgent(agentId: string): Promise<{
  personaPath: string;
  /** Absolute path to the agent's long-term memory dir, if declared and on
   *  disk. The slot-path persona kit and the auto-scaffold writers both
   *  pre-populate `agent.json::memoryDir` with this so the memory slot can
   *  read it without re-walking the plugin registry every turn. */
  memoryDir?: string;
  /** Host 工具白名单 glob（manifest `provides.agent.tools`）。host-tools 桥据此
   *  决定把哪些 exposedToAI 宿主工具注入此 agent 的对话工具清单。 */
  tools?: string[];
  source: 'plugin' | 'marketplace';
} | null> {
  // 1) Plugin agents — entry.personaPath is already absolute.
  const plugin = lookupAgent(agentId);
  if (plugin && plugin.personaPath && existsSync(plugin.personaPath)) {
    let memoryDir: string | undefined;
    if (plugin.definition.memoryDir) {
      const pluginDir = pluginDirOf(plugin.pluginId);
      if (pluginDir) {
        const abs = resolveMemoryDir(pluginDir, plugin.definition.memoryDir);
        if (existsSync(abs)) memoryDir = abs;
      }
    }
    return { personaPath: plugin.personaPath, memoryDir, tools: plugin.definition.tools, source: 'plugin' };
  }
  // 2) Legacy peers in marketplace/manifest.json.
  const mpRoot = findMarketplaceRoot();
  if (!mpRoot) return null;
  const manifest = await readMarketplaceManifest(mpRoot);
  if (!manifest) return null;
  const a = (manifest.agents ?? []).find((x) => x.id === agentId);
  if (!a) return null;
  const personaRel = a.peerFile ?? a.personaFiles?.zh ?? a.personaFiles?.en;
  if (!personaRel) return null;
  const abs = join(mpRoot, personaRel);
  if (!existsSync(abs)) return null;
  return { personaPath: abs, source: 'marketplace' };
}

function pluginDirOf(pluginId: string): string | null {
  const m = getPluginSnapshot().manifests.find((mm) => mm.manifest.id === pluginId);
  if (!m) return null;
  return dirname(m.originPath);
}

function resolveSkillFile(pluginDir: string, file: string): string {
  if (file.startsWith('/')) return file;
  return join(pluginDir, file);
}
