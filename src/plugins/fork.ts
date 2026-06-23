/**
 * Phase D6 (2/4) — Fork an existing plugin into L1 or L2.
 *
 * "Fork & Vibe" path from 09-NON-EXPERT-AUTHORING.md §2.2:
 *   - copy <srcDir>/ → <destRoot>/.forgeax/plugins/<slug>/
 *   - patch forgeax-plugin.json: rewrite `id`, append "(我的)" / "(mine)" to
 *     displayName so the fork is visually distinct in the sidebar
 *   - L1 has higher precedence than L0, so the fork immediately shadows the
 *     original (the doc explicitly relies on this)
 *
 * Conflict policy is intentionally simple: if the target slug already exists
 * we refuse with `{code:'exists'}`. The UI is expected to round-trip with a
 * different newId rather than silently overwrite.
 */
import { mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultLayerRoots } from './scanner';
import { getPluginSnapshot } from './registry';

export interface ForkInput {
  /** id of the plugin to fork (must exist in the current snapshot) */
  srcId: string;
  /** target id; default is `<srcId>-mine` */
  newId?: string;
  /** target layer; default L1 (so the fork shadows L0 for the same author) */
  destLayer?: 'L1' | 'L2';
  /** project root for L2 — required when destLayer='L2' */
  projectRoot?: string;
}

export type ForkResult =
  | { ok: true; id: string; dir: string; layer: 'L1' | 'L2' }
  | { ok: false; code: 'not_found' | 'exists' | 'bad_input' | 'fs_error'; error: string };

/** Build a default fork id. `@scope/foo` → `@scope/foo-mine`. */
export function defaultForkId(srcId: string): string {
  // 不重复加 -mine 后缀,避免 fork-of-fork 出现 -mine-mine
  if (srcId.endsWith('-mine')) return `${srcId}-2`;
  return `${srcId}-mine`;
}

/** Slug = the last segment of the id (after the slash). Used as the on-disk
 *  directory name. We don't store @scope/ in the directory name because
 *  filesystem paths can't carry @ cleanly across all OSes. */
function slugFor(id: string): string {
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export async function forkPlugin(input: ForkInput): Promise<ForkResult> {
  if (!input.srcId) {
    return { ok: false, code: 'bad_input', error: 'srcId is required' };
  }
  const newId = input.newId?.trim() || defaultForkId(input.srcId);
  if (newId === input.srcId) {
    return { ok: false, code: 'bad_input', error: 'newId must differ from srcId' };
  }
  if (!/^@[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(newId)) {
    return { ok: false, code: 'bad_input', error: `newId malformed: ${newId} (expected @scope/name)` };
  }

  const snap = getPluginSnapshot();
  const src = snap.manifests.find((m) => m.manifest.id === input.srcId);
  if (!src) {
    return { ok: false, code: 'not_found', error: `srcId not in current snapshot: ${input.srcId}` };
  }
  if (snap.manifests.some((m) => m.manifest.id === newId)) {
    return { ok: false, code: 'exists', error: `newId already loaded: ${newId}` };
  }

  const layer = input.destLayer ?? 'L1';
  const roots = defaultLayerRoots({ projectRoot: input.projectRoot });
  let destLayerRoot: string;
  if (layer === 'L1') {
    destLayerRoot = roots.L1 ?? resolve(homedir(), '.forgeax/plugins');
  } else {
    if (!input.projectRoot) {
      return { ok: false, code: 'bad_input', error: 'projectRoot required for destLayer=L2' };
    }
    destLayerRoot = roots.L2 ?? resolve(input.projectRoot, '.forgeax/plugins');
  }
  const destDir = join(destLayerRoot, slugFor(newId));
  if (existsSync(destDir)) {
    return { ok: false, code: 'exists', error: `target dir already exists: ${destDir}` };
  }

  const srcDir = dirname(src.originPath);

  try {
    mkdirSync(destLayerRoot, { recursive: true });
    cpSync(srcDir, destDir, { recursive: true });
    // node_modules / build artefacts shouldn't ship; we keep cpSync simple here
    // and trust the fork to be a hand-authored plugin tree (not a built
    // workbench dist). For built workbenches, ship a `.fxpack` instead.

    const manifestPath = join(destDir, 'forgeax-plugin.json');
    if (!existsSync(manifestPath)) {
      return { ok: false, code: 'fs_error', error: `forgeax-plugin.json missing in fork dest: ${destDir}` };
    }
    const raw = readFileSync(manifestPath, 'utf-8');
    const m = JSON.parse(raw) as Record<string, unknown>;
    m.id = newId;
    m.displayName = patchDisplayName(m.displayName, '(我的)');
    writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, 'utf-8');
  } catch (e) {
    return { ok: false, code: 'fs_error', error: (e as Error).message };
  }

  return { ok: true, id: newId, dir: destDir, layer };
}

function patchDisplayName(v: unknown, suffix: string): unknown {
  if (typeof v === 'string') return `${v} ${suffix}`;
  if (v && typeof v === 'object') {
    const o = { ...(v as Record<string, string>) };
    for (const k of Object.keys(o)) o[k] = `${o[k]} ${suffix}`;
    return o;
  }
  return suffix;
}
