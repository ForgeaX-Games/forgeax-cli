// packages/cli/src/extensions/slim-list.ts
//
// The slim extension list the shell strip consumes (formerly api/bus.ts
// loadExtensionList, ADR 0025 M3): manifest snapshot -> UI-facing ExtensionInfo
// items, with dev-port overrides + stable workbench-position sort. Served by
// GET /api/extensions/list (api/extensions.ts).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAllLayers } from './scanner';
import { mergeManifests } from './merger';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { computeAgentNaming, pickPersonName } from '../api/lib/agent-naming';

interface ExtensionManifest {
  schemaVersion?: number;
  id?: string;
  version?: string;
  kind?: string;
  displayName?: { zh?: string; en?: string; ja?: string } | string;
  description?: { zh?: string; en?: string; ja?: string } | string;
  icon?: string;
  experimental?: boolean;
  provides?: {
    workbench?: {
      id?: string;
      icon?: string;
      position?: number;
      panelSize?: 'sm' | 'md' | 'lg';
      hidden?: boolean;
      panes?: {
        left?: { defaultWidth?: number; minWidth?: number; collapsible?: boolean; minHeight?: number; scrollable?: boolean };
        center?: { defaultWidth?: number; minWidth?: number; collapsible?: boolean; minHeight?: number; scrollable?: boolean };
      };
      preferredAgent?: string;
    };
    modelBinding?: {
      channel: string;
      vendor: string;
      models?: string[];
      roles?: string[];
    };
    /** M4 — workbench extension's bundled persona family (same shape as
     *  the singular `agent` entries; slim projection only needs id/role). */
    agents?: Array<{ id?: string; role?: string }>;
    skills?: Array<{ id: string; trigger?: string }>;
    tools?: Array<{ id: string; exposedToAI?: boolean }>;
    events?: Array<{ name: string }>;
    cliProvider?: {
      id: string;
      displayName?: string;
      models?: string[];
      capabilities?: {
        streaming?: boolean;
        thinking?: boolean;
        toolCalls?: boolean;
        subAgents?: boolean;
        sessions?: boolean;
      };
    };
    agent?: {
      id?: string;
      role?: string;
      personaFile?: string;
      memoryDir?: string;
      preferredCliProvider?: string;
      defaultLang?: string;
      multiInstance?: boolean;
      defaultSkills?: unknown[];
      produces?: string[];
      card?: {
        name?: { zh?: string; en?: string } | string;
        cnTitle?: string;
        enTitle?: string;
        color?: string;
        avatar?: string;
      };
    };
  };
  entry?: {
    frontend?: string;
    standalone?: {
      start?: string;
      port?: number;
      readyProbe?: string;
      embeddedAlso?: boolean;
    };
  };
}

export interface ExtensionInfo {
  id: string;
  version: string;
  kind: string;
  displayName: { zh?: string; en?: string; ja?: string } | string;
  description?: { zh?: string; en?: string; ja?: string } | string;
  icon?: string;
  experimental?: boolean;
  workbench?: ExtensionManifest['provides'] extends infer P
    ? P extends { workbench?: infer W }
      ? W
      : never
    : never;
  modelBinding?: ExtensionManifest['provides'] extends infer P
    ? P extends { modelBinding?: infer M }
      ? M
      : never
    : never;
  /** M4 — bundled persona family of a workbench extension (id/role only). */
  agents?: Array<{ id: string; role: string }>;
  skills?: Array<{ id: string; trigger: string }>;
  tools?: Array<{ id: string; exposedToAI?: boolean }>;
  events?: Array<{ name: string }>;
  cliProvider?: {
    id: string;
    displayName: string;
    models?: string[];
    capabilities: {
      streaming: boolean;
      thinking: boolean;
      toolCalls: boolean;
      subAgents: boolean;
      sessions: boolean;
    };
  };
  agent?: {
    id: string;
    role: string;
    personaFile?: string;
    memoryDir?: string;
    preferredCliProvider?: string;
    defaultLang?: string;
    multiInstance?: boolean;
    defaultSkills?: unknown[];
    produces?: string[];
    card?: {
      name?: { zh?: string; en?: string } | string;
      cnTitle?: string;
      enTitle?: string;
      color?: string;
      avatar?: string;
    };
  };
  /** 统一命名（kind=agent 才有）：title=「中文职能·英文名」，sub=灰字英文职能。 */
  naming?: { title: string; sub: string };
  entry?: {
    frontend?: string;
    standalone?: {
      start?: string;
      port?: number;
      readyProbe?: string;
      embeddedAlso?: boolean;
    };
  };
}

interface ExtensionDevPortOverrides {
  plugins?: Record<string, {
    frontendPort?: number;
    backendPort?: number;
  }>;
}

function extensionDevPortOverridesPath(): string {
  // New env/file names first (ADR 0025 词汇清尾, run.ts writes these);
  // legacy names accepted so an old running stack keeps working across the
  // rename (file is regenerated on every `bun fx start`).
  return process.env.FORGEAX_EXTENSION_DEV_PORTS_FILE
    ?? process.env.FORGEAX_PLUGIN_DEV_PORTS_FILE
    ?? [
      join(defaultProjectRoot(), '.forgeax', 'extension-dev-ports.json'),
      join(defaultProjectRoot(), '.forgeax', 'plugin-dev-ports.json'),
    ].find(existsSync)
    ?? join(defaultProjectRoot(), '.forgeax', 'extension-dev-ports.json');
}

function loadExtensionDevPortOverrides(): ExtensionDevPortOverrides | null {
  const path = extensionDevPortOverridesPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ExtensionDevPortOverrides;
  } catch (e) {
    console.warn(`[api/bus] ignored invalid plugin dev port overrides: ${(e as Error).message}`);
    return null;
  }
}

function isUsablePort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
}

function applyExtensionDevPortOverrides(
  items: ExtensionInfo[],
  overrides: ExtensionDevPortOverrides | null,
): ExtensionInfo[] {
  if (!overrides?.plugins) return items;
  for (const item of items) {
    const override = overrides.plugins[item.id];
    if (!override || !isUsablePort(override.frontendPort) || !item.entry?.standalone) continue;
    item.entry.standalone.port = override.frontendPort;
  }
  return items;
}

export function applyExtensionDevPortOverridesForTest(
  items: ExtensionInfo[],
  overrides: ExtensionDevPortOverrides | null,
): ExtensionInfo[] {
  return applyExtensionDevPortOverrides(items, overrides);
}

export async function loadExtensionList(): Promise<ExtensionInfo[]> {
  const scan = await scanAllLayers();
  const merged = mergeManifests(scan.found);
  const items: ExtensionInfo[] = [];
  for (const mergedManifest of merged.manifests) {
    const m = mergedManifest.manifest as ExtensionManifest;
    if (!m.id || !m.version || !m.kind || !m.displayName) continue;
      const slim: ExtensionInfo = {
        id: m.id,
        version: m.version,
        kind: m.kind,
        displayName: m.displayName,
        description: m.description,
        icon: m.icon,
        experimental: m.experimental,
      };
      if (m.provides?.workbench) {
        slim.workbench = {
          id: m.provides.workbench.id ?? m.id,
          icon: m.provides.workbench.icon ?? m.icon,
          position: m.provides.workbench.position,
          panelSize: m.provides.workbench.panelSize,
          hidden: m.provides.workbench.hidden,
          // Doc 06 §panes — only project the keys the manifest explicitly set so
          // a plugin without panes stays panes-undefined (Sidebar uses presence
          // of `panes.left` to decide left-iframe vs placeholder render).
          ...(m.provides.workbench.panes
            ? { panes: m.provides.workbench.panes }
            : {}),
          ...(m.provides.workbench.preferredAgent
            ? { preferredAgent: m.provides.workbench.preferredAgent }
            : {}),
        } as ExtensionInfo['workbench'];
      }
      if (m.provides?.modelBinding) {
        slim.modelBinding = {
          channel: m.provides.modelBinding.channel,
          vendor: m.provides.modelBinding.vendor,
          models: m.provides.modelBinding.models ?? [],
          roles: m.provides.modelBinding.roles,
        } as ExtensionInfo['modelBinding'];
      }
      if (m.provides?.skills?.length) {
        slim.skills = m.provides.skills.map((s) => ({
          id: s.id,
          trigger: s.trigger ?? `/${s.id}`,
        }));
      }
      if (m.provides?.tools?.length) {
        slim.tools = m.provides.tools.map((t) => ({
          id: t.id,
          exposedToAI: t.exposedToAI,
        }));
      }
      if (m.provides?.events?.length) {
        slim.events = m.provides.events.map((e) => ({ name: e.name }));
      }
      // M4: workbench extension carrying its own persona family — surface a
      // slim id/role list (counts + Settings display; full defs live in the
      // agents kind registry).
      if (m.provides?.agents?.length) {
        slim.agents = m.provides.agents
          .filter((a): a is { id: string; role?: string } => Boolean(a.id))
          .map((a) => ({ id: a.id, role: a.role ?? 'unknown' }));
      }
      if (m.provides?.agent) {
        const a = m.provides.agent;
        slim.agent = {
          id: a.id ?? m.id,
          role: a.role ?? 'unknown',
          personaFile: a.personaFile,
          memoryDir: a.memoryDir,
          preferredCliProvider: a.preferredCliProvider,
          defaultLang: a.defaultLang,
          multiInstance: a.multiInstance,
          defaultSkills: a.defaultSkills,
          produces: a.produces,
          card: a.card,
        };
        const cn = a.card?.cnTitle;
        const fallback = typeof m.displayName === 'string'
          ? m.displayName
          : (m.displayName.zh ?? m.displayName.en ?? a.id ?? m.id);
        slim.naming = computeAgentNaming({
          personName: cn ? pickPersonName(a.card?.name) : undefined,
          cnTitle: cn,
          enTitle: a.card?.enTitle,
          fallback,
        });
      }
      if (m.provides?.cliProvider) {
        const cp = m.provides.cliProvider;
        slim.cliProvider = {
          id: cp.id,
          displayName: cp.displayName ?? cp.id,
          models: cp.models ?? [],
          capabilities: {
            streaming: Boolean(cp.capabilities?.streaming),
            thinking: Boolean(cp.capabilities?.thinking),
            toolCalls: Boolean(cp.capabilities?.toolCalls),
            subAgents: Boolean(cp.capabilities?.subAgents),
            sessions: Boolean(cp.capabilities?.sessions),
          },
        };
      }
      if (m.entry?.frontend || m.entry?.standalone) {
        slim.entry = {};
        if (m.entry.frontend) slim.entry.frontend = m.entry.frontend;
        if (m.entry.standalone) {
          slim.entry.standalone = {
            start: m.entry.standalone.start,
            port: m.entry.standalone.port,
            readyProbe: m.entry.standalone.readyProbe,
            embeddedAlso: m.entry.standalone.embeddedAlso,
          };
        }
      }
      items.push(slim);
  }

  applyExtensionDevPortOverrides(items, loadExtensionDevPortOverrides());

  // Stable sort by workbench position, then id, so the UI strip is deterministic.
  items.sort((a, b) => {
    const ap = a.workbench?.position ?? 999;
    const bp = b.workbench?.position ?? 999;
    if (ap !== bp) return ap - bp;
    return a.id.localeCompare(b.id);
  });

  return items;
}

