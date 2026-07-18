/**
 * soul-pack 加载器(R6 §2.1/2.2)—— 三来源发现 + 路径→trustTier + 解析为 AgentRecord。
 *
 * 核心铁律:**trustTier 权威 = 加载路径,不信 pack 自报**(R6-02)。
 *   builtin / forge → own;marketplace / user-imported → imported。
 *
 * 两条路径:
 *  1. **原生 soul-pack**(文件夹格式,规格 §1):`persona/identity.md` + `skills/`
 *     + `tools/` + `memory/`。首载把 pack 的 seed 记忆「重生」进可写运行时记忆根
 *     (`.forgeax/souls/<id>/memory`),之后在那里成长。
 *  2. **兼容合成**(R6-07):现状没有原生 pack 的 agent(marketplace persona /
 *     plugin agent)→ 复用 `composeSystemPrompt`/`resolvePersonaForAgent` 合成
 *     AgentRecord,persona 用今天注入的同款 bundle(零回归),运行时记忆根空起步。
 *
 * 设计依据:`forgeax-soul-pack-与-lean-v1-规格.md` §1 + `需求单/R6`。
 */
import type { ToolSpec } from '@forgeax/agent-runtime';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { assetRoot } from '@forgeax/platform-io';
import { composeSystemPrompt, parseSkillFrontmatter, resolvePersonaForAgent } from '../agents/loader';
import { emitLifeEvent } from './life-events';
import { soulMemoryRoot } from './layered-memory';
import type { AgentRecord, LayeredMemoryRef, SkillRefLite, SoulSource, TrustTier } from './types';

const OWN_BUILTIN_IDS = new Set(['', 'default', 'root', 'forge']);

/** 真正「无人格」的通用编排者 —— 这些 id 跳过 persona 装配(它们没有 marketplace 人格)。
 *  注意 `forge` **不在**此集:forge 是有人格的主控编排者(persona 在 marketplace manifest,
 *  经 composeSystemPrompt('forge') 兜底解析),但它仍属 OWN_BUILTIN_IDS → trustTier='own'。
 *  重构曾把 persona 装配错挂在 OWN_BUILTIN_IDS 上 → 连 forge 的人格一起跳过(主控 Forge
 *  人设整段丢失);拆成两套集合后,forge 恢复人格、信任档不变。 */
const NO_PERSONA_IDS = new Set(['', 'default', 'root']);

export interface LoadOpts {
  projectRoot?: string;
  /** 当前游戏世界(转世/携带:episodes 按此隔离)。 */
  game?: string;
}

/** 来源 → 信任档(权威映射;pack 自报被忽略)。 */
export function trustForSource(source: SoulSource): TrustTier {
  return source === 'builtin' || source === 'forge' ? 'own' : 'imported';
}

/** 把一个 agentId「重生」成可跑 AgentRecord。 */
export async function loadAgentRecord(agentId: string, opts: LoadOpts = {}): Promise<AgentRecord> {
  const projectRoot = opts.projectRoot ?? defaultProjectRoot();
  const memory: LayeredMemoryRef = {
    root: soulMemoryRoot(projectRoot, agentId),
    ...(opts.game ? { game: opts.game } : {}),
  };

  const found = findSoulPack(agentId, projectRoot);
  const record = found
    ? parseSoulPack(agentId, found.dir, found.source, memory)
    : await synthFromLegacy(agentId, memory);

  emitLifeEvent({
    kind: 'soul.loaded',
    agentId,
    source: record.source,
    trustTier: record.trustTier,
    at: Date.now(),
  });
  if (opts.game) {
    emitLifeEvent({ kind: 'rebirth.projected', agentId, into: opts.game, at: Date.now() });
  }
  return record;
}

// ─── 原生 soul-pack ─────────────────────────────────────────────────────

interface FoundPack {
  dir: string;
  source: SoulSource;
}

/** 三来源发现(顺序:user-imported → marketplace → builtin);返回首个命中 + 其来源档。 */
export function findSoulPack(agentId: string, projectRoot: string): FoundPack | null {
  const candidates: Array<{ dir: string; source: SoulSource }> = [
    { dir: resolve(projectRoot, '.forgeax/souls-imported', agentId), source: 'user-imported' },
    ...marketplaceRoots(projectRoot).map((mp) => ({ dir: join(mp, 'souls', agentId), source: 'marketplace' as const })),
    { dir: resolve(assetRoot(), 'souls', agentId), source: 'builtin' as const },
    { dir: resolve(projectRoot, '.forgeax/souls-builtin', agentId), source: 'builtin' as const },
  ];
  for (const c of candidates) {
    if (isSoulPackDir(c.dir)) return { dir: c.dir, source: c.source };
  }
  return null;
}

function isSoulPackDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, 'manifest.json')) || existsSync(join(dir, 'persona', 'identity.md'));
}

function parseSoulPack(
  agentId: string,
  dir: string,
  source: SoulSource,
  memory: LayeredMemoryRef,
): AgentRecord {
  const warnings: string[] = [];

  // persona:persona/identity.md 优先,叠加其余 persona/*.md。
  const persona = readPersona(dir, warnings);

  // skills:skills/<id>/SKILL.md。
  const skills = readPackSkills(dir, agentId, warnings);

  // tools:tools/*.json(每个 = ToolSpec 或 ToolSpec[])。
  const tools = readPackTools(dir, warnings);

  // manifest.json 声明式策略(systemPrompt.mode + tools.allow/deny)。trustTier 仍只信路径。
  const policy = readManifestPolicy(dir, warnings);

  // 首载 seed:把 pack 的 memory/ 重生进可写运行时根(运行时根尚无 MEMORY.md 时)。
  seedMemory(dir, memory.root, warnings);

  return {
    agentId,
    source,
    trustTier: trustForSource(source), // 权威 = 路径,忽略 manifest 自报
    persona,
    skills,
    tools,
    ...(policy.promptMode ? { promptMode: policy.promptMode } : {}),
    ...(policy.toolPolicy ? { toolPolicy: policy.toolPolicy } : {}),
    ...(policy.budget ? { budget: policy.budget } : {}),
    memory,
    warnings,
  };
}

/** 解析 manifest.json 的声明式策略:`systemPrompt.mode`('append'|'replace')+
 *  `tools.allow/deny`(opaque 内核工具名数组)。best-effort:无文件/解析失败 → 空策略 +
 *  warning,绝不崩。**注意:trustTier 不在此读**(权威 = 加载路径,R6-02 铁律)。 */
function readManifestPolicy(
  dir: string,
  warnings: string[],
): {
  promptMode?: 'append' | 'replace';
  toolPolicy?: { allow?: string[]; deny?: string[] };
  budget?: { maxTurns?: number; maxBudgetUsd?: number };
} {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    warnings.push(`manifest.json unreadable: ${(e as Error).message}`);
    return {};
  }
  const m = (raw && typeof raw === 'object' ? raw : {}) as {
    systemPrompt?: { mode?: unknown };
    tools?: { allow?: unknown; deny?: unknown };
    budget?: { maxTurns?: unknown; maxBudgetUsd?: unknown };
  };
  const out: {
    promptMode?: 'append' | 'replace';
    toolPolicy?: { allow?: string[]; deny?: string[] };
    budget?: { maxTurns?: number; maxBudgetUsd?: number };
  } = {};

  const rawMode = m.systemPrompt?.mode;
  if (rawMode === 'append' || rawMode === 'replace') out.promptMode = rawMode;
  else if (rawMode !== undefined) warnings.push(`manifest systemPrompt.mode 非法(${String(rawMode)}),忽略`);

  const cleanList = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    return arr.length ? arr : undefined;
  };
  const allow = cleanList(m.tools?.allow);
  const deny = cleanList(m.tools?.deny);
  if (allow || deny) out.toolPolicy = { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };

  const posNum = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const maxTurns = posNum(m.budget?.maxTurns);
  const maxBudgetUsd = posNum(m.budget?.maxBudgetUsd);
  if (maxTurns !== undefined || maxBudgetUsd !== undefined) {
    out.budget = { ...(maxTurns !== undefined ? { maxTurns } : {}), ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}) };
  }

  return out;
}

function readPersona(dir: string, warnings: string[]): string {
  const personaDir = join(dir, 'persona');
  const parts: string[] = [];
  const identity = join(personaDir, 'identity.md');
  if (existsSync(identity)) {
    parts.push(safeRead(identity, warnings));
  }
  try {
    for (const f of readdirSync(personaDir).filter((x) => x.toLowerCase().endsWith('.md')).sort()) {
      if (f.toLowerCase() === 'identity.md') continue;
      parts.push(safeRead(join(personaDir, f), warnings));
    }
  } catch {
    /* no persona dir */
  }
  const text = parts.filter((p) => p.trim()).join('\n\n');
  if (!text.trim()) warnings.push('soul-pack persona empty (no persona/identity.md)');
  return text;
}

function readPackSkills(dir: string, agentId: string, warnings: string[]): SkillRefLite[] {
  const skillsDir = join(dir, 'skills');
  const out: SkillRefLite[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const skillMd = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    let description = '';
    try {
      const fm = parseSkillFrontmatter(readFileSync(skillMd, 'utf-8'));
      description = fm.description ?? '';
    } catch (e) {
      warnings.push(`skill ${name} unreadable: ${(e as Error).message}`);
    }
    out.push({ skillId: name, extensionId: `soul:${agentId}`, kind: 'prompt', description });
  }
  return out;
}

function readPackTools(dir: string, warnings: string[]): ToolSpec[] {
  const toolsDir = join(dir, 'tools');
  const out: ToolSpec[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(toolsDir);
  } catch {
    return out;
  }
  for (const f of entries.filter((x) => x.toLowerCase().endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(toolsDir, f), 'utf-8')) as unknown;
      for (const t of Array.isArray(parsed) ? parsed : [parsed]) {
        const spec = t as Partial<ToolSpec>;
        if (spec && typeof spec.name === 'string') {
          out.push({
            name: spec.name,
            ...(spec.description ? { description: spec.description } : {}),
            ...(spec.inputSchema ? { inputSchema: spec.inputSchema } : {}),
          });
        }
      }
    } catch (e) {
      warnings.push(`tool spec ${f} unreadable: ${(e as Error).message}`);
    }
  }
  return out;
}

/** 把 pack 的 seed 记忆复制进可写运行时根(仅当运行时根还没 MEMORY.md,避免覆盖已成长的记忆)。 */
function seedMemory(packDir: string, runtimeRoot: string, warnings: string[]): void {
  const seedDir = join(packDir, 'memory');
  if (!existsSync(seedDir)) return;
  if (existsSync(join(runtimeRoot, 'MEMORY.md'))) return; // 已重生过,不覆盖成长
  try {
    cpSync(seedDir, runtimeRoot, { recursive: true });
  } catch (e) {
    warnings.push(`memory seed failed: ${(e as Error).message}`);
  }
}

// ─── 兼容合成(R6-07:现状 agent 无原生 pack)──────────────────────────────

async function synthFromLegacy(agentId: string, memory: LayeredMemoryRef): Promise<AgentRecord> {
  const id = agentId.trim();
  const warnings: string[] = [];

  // 来源/信任:builtin 编排者(forge/default/root) → forge/own;否则看 persona 解析来源。
  let source: SoulSource = 'forge';
  if (!OWN_BUILTIN_IDS.has(id)) {
    const resolved = await resolvePersonaForAgent(id).catch(() => null);
    source = resolved?.source === 'plugin' && resolved.layer === 'L0'
      ? 'builtin'
      : resolved
        ? 'marketplace'
        : 'builtin';
  }

  // persona:复用今天注入的同款 bundle(persona + skill index + 平铺 memory)→ 零回归。
  let persona = '';
  const skills: SkillRefLite[] = [];
  if (!NO_PERSONA_IDS.has(id)) {
    try {
      const composed = await composeSystemPrompt(id);
      if (composed) {
        persona = composed.text.trim();
        for (const s of composed.skillIndex) {
          skills.push({ skillId: s.skillId, extensionId: s.extensionId, kind: s.kind, description: s.description });
        }
        warnings.push(...composed.warnings);
      }
    } catch (e) {
      warnings.push(`legacy persona compose failed: ${(e as Error).message}`);
    }
  }

  return {
    agentId,
    source,
    trustTier: trustForSource(source),
    persona,
    skills,
    tools: [], // 兼容路径不自带 soul 工具;编排层默认工具集另行注入
    memory,
    warnings,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function safeRead(abs: string, warnings: string[]): string {
  try {
    return readFileSync(abs, 'utf-8');
  } catch (e) {
    warnings.push(`unreadable ${abs}: ${(e as Error).message}`);
    return '';
  }
}

function marketplaceRoots(projectRoot: string): string[] {
  return [
    resolve(assetRoot(), 'marketplace'),
    resolve(projectRoot, 'packages/marketplace'),
    resolve(projectRoot, 'marketplace'),
  ].filter((p) => existsSync(p));
}
