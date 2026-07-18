/**
 * host-authoring —— tool handler 的「宿主编排能力」缝(GAP 5)。
 *
 *  背景:产品层的 authoring 工具(如 `team:create_role`)是 marketplace 插件,
 *  其 handler 经 `await import(entry.backend)` 跑在宿主(cli)进程里,**但 ESM 裸
 *  说明符从插件目录向上解析,解析不到 `@forgeax/*`**(实测 ERR_MODULE_NOT_FOUND)。
 *  所以 handler 拿不到 parseManifest / writeAgentPack / reloadExtensions —— 一切
 *  宿主能力只能经 ToolRegistry 注入的 `ctx.host` 缝流入。
 *
 *  本模块把「铸造一个 agent-pack」这件通用 authoring 事收敛成一个 host 能力:
 *    - 组装 manifest(spec → forgeax-extension.json kind:agent)
 *    - parseManifest 自验(fail fast,§Schema-as-Contract)
 *    - 双名字空间撞名查重(plugin snapshot + marketplace legacy) —— 否则新角色会
 *      **静默遮蔽**内建角色(resolvePersonaForAgent 是 plugin-first)
 *    - 调 platform-io 的纯 IO primitive writeAgentPack 落盘(L1/L2,目录存在即拒)
 *  以及 reloadExtensions(让刚落盘的角色进 snapshot → 下一轮 roster 自动带上)。
 *
 *  这是**通用缝**:任何写插件的产品工具都需要它,不是 team-forge 的产品逻辑。
 *  产品语义(角色叫什么、persona 文案、确认卡、默认头像色)全留在插件侧。
 */
import { parseManifest, pickI18n, type I18nString } from '@forgeax/types';
import {
  writeAgentPack,
  defaultProjectRoot,
  assetRoot,
  type AgentPackScope,
} from '@forgeax/platform-io';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reloadExtensions } from '../extensions/registry';
import { listAgents } from '../agents/loader';
import { isValidAgentName } from '../core/agent-scaffold';

/** 产品工具喂进来的角色规格(与 wb-team-forge 的 create-role.args.json 对齐)。 */
export interface AgentPackSpec {
  /** 单段 [a-zA-Z0-9_-];会被小写化作 plugin id 段与 agent id。 */
  id: string;
  displayName?: I18nString;
  /** 如 'pillar' / 'artist' / 'peer';缺省 'peer'。 */
  role?: string;
  /** 角色 system 提示词(= persona/zh.md),必填。 */
  persona: string;
  /** emoji/单字符;缺省取 id 首字母。 */
  avatar?: string;
  /** #hex;缺省固定色。 */
  color?: string;
  /** 'global'(L1,默认) | 'project'(L2)。 */
  scope?: AgentPackScope;
  /** 可选记忆种子 → memory/lessons.md。 */
  memorySeed?: string;
  /** 该角色可用的 host 工具 allow glob(→ provides.agent.tools,首派时注入)。 */
  tools?: string[];
}

export type CreateAgentPackResult =
  | { ok: true; id: string; extensionId: string; dir: string; scope: AgentPackScope }
  | {
      ok: false;
      code: 'bad_input' | 'exists' | 'invalid_manifest' | 'fs_error';
      error: string;
    };

export interface RosterEntry {
  id: string;
  role: string;
  displayName: string;
  source: 'plugin' | 'marketplace';
}

export interface HostAuthoring {
  /** 重扫插件层(L0/L1/L2),刷新 snapshot。让刚落盘的 agent-pack 生效。 */
  reloadExtensions(): Promise<void>;
  /** 组装 + 自验 + 撞名查重 + 落盘一个 agent-pack。不 reload(调用方自行决定)。 */
  createAgentPack(spec: AgentPackSpec): Promise<CreateAgentPackResult>;
  /** 当前可派单角色(plugin agents + marketplace legacy)的合集,供 list_roles。 */
  listRoles(): RosterEntry[];
}

const DEFAULT_COLOR = '#8B95A5';

/** 复制 subagent_roster 的 marketplace 根查找(自包含,避免依赖 loader 私有函数)。 */
function findMarketplaceRoot(): string | null {
  const root = defaultProjectRoot();
  const candidates = [
    resolve(assetRoot(), 'marketplace'),
    resolve(root, 'packages/marketplace'),
    resolve(root, '../packages/marketplace'),
    resolve(root, '../../packages/marketplace'),
    resolve(root, 'marketplace'),
    resolve(root, '../marketplace'),
  ];
  return candidates.find((p) => existsSync(join(p, 'manifest.json'))) ?? null;
}

interface MarketplaceLegacyAgent {
  id: string;
  role?: string;
  cardName?: I18nString;
  card?: { name?: I18nString };
  displayName?: I18nString;
}

function readMarketplaceAgents(): MarketplaceLegacyAgent[] {
  const mp = findMarketplaceRoot();
  if (!mp) return [];
  try {
    const raw = readFileSync(join(mp, 'manifest.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { agents?: MarketplaceLegacyAgent[] };
    return parsed.agents ?? [];
  } catch {
    return [];
  }
}

function collectRoster(): RosterEntry[] {
  const rows: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const e of listAgents()) {
    const id = e.definition.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      role: e.definition.role,
      displayName: pickI18n(e.definition.card.name, 'zh') || id,
      source: 'plugin',
    });
  }
  for (const a of readMarketplaceAgents()) {
    if (!a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    rows.push({
      id: a.id,
      role: a.role ?? 'peer',
      displayName:
        pickI18n(a.card?.name ?? a.cardName ?? a.displayName, 'zh') || a.id,
      source: 'marketplace',
    });
  }
  return rows;
}

/** 组装标准 agent-pack manifest 对象(kind:agent)。 */
function buildAgentManifest(id: string, spec: AgentPackSpec): {
  manifest: unknown;
  extensionId: string;
  slug: string;
} {
  const slug = `agent-${id}`;
  const extensionId = `@user/${slug}`;
  const displayName: I18nString =
    spec.displayName && (typeof spec.displayName === 'string'
      ? spec.displayName.trim()
      : spec.displayName.zh || spec.displayName.en || spec.displayName.ja)
      ? spec.displayName
      : { zh: id, en: id };
  const cardName: I18nString =
    typeof displayName === 'string' ? { zh: displayName, en: displayName } : displayName;
  const avatar = (spec.avatar && spec.avatar.trim()) || id.slice(0, 1).toUpperCase();
  const color = (spec.color && spec.color.trim()) || DEFAULT_COLOR;
  const manifest = {
    schemaVersion: 1,
    id: extensionId,
    version: '0.1.0',
    kind: 'agent',
    displayName,
    description: {
      zh: `由 Forge 通过 team:create_role 铸造的自定义队友「${id}」。`,
    },
    provides: {
      agent: {
        id,
        role: spec.role?.trim() || 'peer',
        card: { name: cardName, color, avatar },
        personaFile: './persona/zh.md',
        ...(spec.memorySeed && spec.memorySeed.trim() ? { memoryDir: './memory/' } : {}),
        defaultLang: 'zh',
        ...(spec.tools && spec.tools.length > 0 ? { tools: spec.tools } : {}),
      },
    },
    experimental: true,
  };
  return { manifest, extensionId, slug };
}

/** 组装 host-authoring 能力实例(ToolRegistry 注入进 ctx.host)。 */
export function createHostAuthoring(): HostAuthoring {
  return {
    async reloadExtensions() {
      await reloadExtensions();
    },

    listRoles() {
      return collectRoster();
    },

    async createAgentPack(spec) {
      const rawId = String(spec?.id ?? '').trim();
      const id = rawId.toLowerCase();
      if (!id || !isValidAgentName(id)) {
        return {
          ok: false,
          code: 'bad_input',
          error: `invalid role id ${JSON.stringify(rawId)} — must be a single segment [a-zA-Z0-9_-]`,
        };
      }
      if (typeof spec.persona !== 'string' || !spec.persona.trim()) {
        return { ok: false, code: 'bad_input', error: 'persona is required and must be non-empty' };
      }
      // 双名字空间撞名查重:plugin snapshot + marketplace legacy。撞任一 → 拒,
      // 不静默覆盖(照 fork.ts 的 {code:'exists'} 幂等策略)。
      const existing = new Set(collectRoster().map((r) => r.id));
      if (existing.has(id)) {
        return { ok: false, code: 'exists', error: `role id already exists: ${id}` };
      }
      const { manifest, extensionId, slug } = buildAgentManifest(id, spec);
      // Fail fast:落盘前 zod 自验(Schema as Contract)。
      const parsed = parseManifest(manifest);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'invalid_manifest',
          error: `assembled agent-pack manifest failed validation: ${parsed.error?.issues
            ?.map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        };
      }
      const scope: AgentPackScope = spec.scope === 'project' ? 'project' : 'global';
      const res = writeAgentPack(
        { slug, manifest, persona: spec.persona, memorySeed: spec.memorySeed },
        { scope, projectRoot: defaultProjectRoot() },
      );
      if (!res.ok) return res;
      return { ok: true, id, extensionId, dir: res.dir, scope: res.scope };
    },
  };
}

// 单例:host 进程内共享一份(reloadExtensions 是全局 snapshot,createAgentPack 无状态)。
let _instance: HostAuthoring | null = null;
export function getHostAuthoring(): HostAuthoring {
  if (!_instance) _instance = createHostAuthoring();
  return _instance;
}
