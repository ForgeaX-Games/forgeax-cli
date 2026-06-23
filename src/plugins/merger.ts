/**
 * Phase B1 — ManifestMerger.
 *
 * Dedupes scanned manifests by `id`, applying the L2 > L1 > L0 layering rule
 * (project beats user beats builtin), and topologically sorts the survivors
 * by `dependencies`. Shadowed entries are recorded so SettingsPanel can
 * surface "this builtin is overridden by your project copy" hints.
 *
 * See docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §2.1.
 */
import type { PluginManifest } from '@forgeax/types';
import type { PluginLayer, ScannedManifest } from './scanner';

export interface MergedManifest {
  manifest: PluginManifest;
  layer: PluginLayer;
  originPath: string;
  /** Lower-precedence copies of the same id, ordered most→least specific. */
  shadowedBy: Array<{ layer: PluginLayer; originPath: string }>;
}

export interface MergeIssue {
  kind: 'unknown-dependency' | 'cycle';
  pluginId: string;
  detail: string;
}

export interface MergeResult {
  /** Topologically sorted survivors (deps before dependents). */
  manifests: MergedManifest[];
  issues: MergeIssue[];
}

const LAYER_RANK: Record<PluginLayer, number> = { L0: 0, L1: 1, L2: 2 };

/** Apply L2 > L1 > L0 dedupe + topological sort.
 *
 *  Topo failures (unknown dep, cycle) are reported in `issues` and the
 *  affected plugin is appended at the end in id-stable order so callers
 *  can still see it (loader will skip it). */
export function mergeManifests(scanned: ScannedManifest[]): MergeResult {
  const byId = new Map<string, ScannedManifest[]>();
  for (const s of scanned) {
    const arr = byId.get(s.manifest.id) ?? [];
    arr.push(s);
    byId.set(s.manifest.id, arr);
  }

  const winners: MergedManifest[] = [];
  for (const [, copies] of byId) {
    copies.sort((a, b) => LAYER_RANK[b.layer] - LAYER_RANK[a.layer]);
    const [head, ...rest] = copies;
    winners.push({
      manifest: head.manifest,
      layer: head.layer,
      originPath: head.originPath,
      shadowedBy: rest.map((r) => ({ layer: r.layer, originPath: r.originPath })),
    });
  }
  // Stable order baseline before topo (id ascending) so equal-depth deps stay deterministic.
  winners.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));

  return topoSort(winners);
}

function topoSort(items: MergedManifest[]): MergeResult {
  const issues: MergeIssue[] = [];
  const known = new Set(items.map((i) => i.manifest.id));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const m of items) {
    incoming.set(m.manifest.id, new Set());
    outgoing.set(m.manifest.id, new Set());
  }
  for (const m of items) {
    const deps = m.manifest.dependencies ?? [];
    for (const d of deps) {
      if (d.optional) continue;
      if (!known.has(d.id)) {
        issues.push({
          kind: 'unknown-dependency',
          pluginId: m.manifest.id,
          detail: `requires ${d.id}${d.versionRange ? `@${d.versionRange}` : ''} but it is not installed`,
        });
        continue;
      }
      incoming.get(m.manifest.id)!.add(d.id);
      outgoing.get(d.id)!.add(m.manifest.id);
    }
  }

  // Kahn: queue items whose incoming-set is empty, in id order.
  const byId = new Map(items.map((m) => [m.manifest.id, m]));
  const queue: string[] = [];
  for (const m of items) {
    if (incoming.get(m.manifest.id)!.size === 0) queue.push(m.manifest.id);
  }
  queue.sort();
  const sorted: MergedManifest[] = [];
  const placed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    placed.add(id);
    const node = byId.get(id)!;
    sorted.push(node);
    const fanOut = [...outgoing.get(id)!].sort();
    for (const nx of fanOut) {
      const inc = incoming.get(nx)!;
      inc.delete(id);
      if (inc.size === 0) queue.push(nx);
    }
  }

  if (placed.size < items.length) {
    for (const m of items) {
      if (placed.has(m.manifest.id)) continue;
      issues.push({
        kind: 'cycle',
        pluginId: m.manifest.id,
        detail: 'dependency cycle — plugin will not be loaded',
      });
      sorted.push(m);
    }
  }

  return { manifests: sorted, issues };
}
