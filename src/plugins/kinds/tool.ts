/**
 * Phase D1 — tool kind loader.
 *
 * Walks every merged manifest and extracts ManifestToolEntry records from
 * `provides.tools[]` (any of kind=workbench/agent/skill/tool can carry tools).
 * Schema refs (args/returns) given as strings are resolved relative to the
 * manifest dir but **not** read from disk here — the loader only normalizes
 * the path so ToolRegistry.call() can read it lazily on first dispatch.
 *
 * Handler resolution mirrors cli-provider: `entry.backend` (when present) is
 * recorded as an absolute path and dynamic-imported on first `call()`. The
 * imported module must export an object whose keys match the tool ids:
 *
 *     // entry.backend
 *     export default {
 *       'wb-character.generate': async (args, ctx) => { ... },
 *     }
 *
 * Tools whose plugin omits entry.backend get registered as **schema-only** —
 * /api/tools/list will surface them but /api/tools/call returns 501. That
 * lets manifest-only authoring (D6) ship a tool catalog before any handler
 * lands.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ManifestToolEntry, PluginManifest } from '@forgeax/types';
import type { MergedManifest } from '../merger';
import type { PluginLayer } from '../scanner';
import type { KindLoadIssue } from './types';

export interface ToolEntry {
  pluginId: string;
  layer: PluginLayer;
  toolId: string;
  /** Absolute path to args JSONSchema file, or the inline object. */
  argsSchema?: unknown;
  /** Absolute path to returns JSONSchema file, or the inline object. */
  returnsSchema?: unknown;
  exposedToAI: boolean;
  /** 07 §9.5 — handler must wait for user ack before running for AI callers.
   *  Three-value enum aligned with ManifestToolEntrySchema.requireConfirm:
   *  'always' (every ai call), 'destructive' (irreversible side-effects),
   *  'never' / undefined (bypass gate). Only caller.kind='ai' is gated. */
  requireConfirm?: 'always' | 'destructive' | 'never';
  /** Optional confirm-dialog body. */
  confirmMessage?: string;
  description?: string;
  /** Resolved absolute path to entry.backend, or null if schema-only. */
  backendPath: string | null;
  /** GAP 5 — env keys the plugin's manifest declared via `requestedEnv`. */
  requestedEnv: string[];
  /** Plugin dir; the registry passes it to handlers as ctx.cwd so they can
   *  read sibling resources without `process.cwd()`. */
  pluginDir: string;
}

function normalizeSchemaRef(
  raw: unknown,
  manifestDir: string,
): unknown {
  if (typeof raw !== 'string') return raw;
  if (!raw.trim()) return undefined;
  return isAbsolute(raw) ? raw : resolve(manifestDir, raw);
}

function pickDescription(d: ManifestToolEntry['description']): string | undefined {
  if (!d) return undefined;
  if (typeof d === 'string') return d;
  return d.zh || d.en;
}

export function loadTools(
  merged: MergedManifest,
): { entries: ToolEntry[]; issues: KindLoadIssue[] } {
  const m = merged.manifest as PluginManifest & { provides?: { tools?: ManifestToolEntry[] } };
  const tools = m.provides?.tools;
  if (!tools || tools.length === 0) return { entries: [], issues: [] };

  const dir = dirname(merged.originPath);
  const backend = m.entry?.backend?.trim();
  const backendPath = backend ? (isAbsolute(backend) ? backend : resolve(dir, backend)) : null;
  const requestedEnv = (m as PluginManifest & { requestedEnv?: string[] }).requestedEnv ?? [];

  const entries: ToolEntry[] = [];
  const issues: KindLoadIssue[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.id)) {
      issues.push({
        kind: 'tool',
        pluginId: m.id,
        reason: `duplicate tool id "${t.id}" in plugin ${m.id}`,
      });
      continue;
    }
    seen.add(t.id);
    entries.push({
      pluginId: m.id,
      layer: merged.layer,
      toolId: t.id,
      argsSchema: normalizeSchemaRef(t.args, dir),
      returnsSchema: normalizeSchemaRef(t.returns, dir),
      exposedToAI: t.exposedToAI ?? false,
      requireConfirm: t.requireConfirm,
      confirmMessage: pickDescription(t.confirmMessage),
      description: pickDescription(t.description),
      backendPath,
      requestedEnv,
      pluginDir: dir,
    });
  }
  return { entries, issues };
}
