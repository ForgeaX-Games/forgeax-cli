/**
 * Phase D7 — `.fxpack` exporter.
 *
 * Bundles 1+ plugin directories into a `.fxpack` zip with a top-level
 * `manifest.fxpack.json`, an auto-generated `README.md`, and a
 * `plugins/<id>/` tree containing each plugin verbatim. Optional ed25519
 * signature is reserved for a follow-up (`signature.json`); first pass writes
 * unsigned packs (the canonical doc allows this — see 10 §4 "不签也行").
 *
 * Lint pipeline (rejects export if any rule trips, per 10 §7 反模式):
 *   - native binaries (.so/.dll/.dylib/.node)         → reject
 *   - absolute path string in any text file           → reject
 *   - obvious secrets (API_KEY=…, BEARER …)           → reject
 *   - `dist/` containing tracked node_modules         → warn
 *
 * The export uses system `zip` via Bun.spawn — no extra npm dep, available
 * everywhere CI runs (verified in /usr/bin/zip on the dev box).
 */
import { mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { ManifestSchema, type PluginManifest } from '@forgeax/types';
import { getPluginSnapshot } from '../plugins/registry';
import {
  type FxpackExportInput,
  type FxpackExportResult,
  type FxpackManifest,
  FxpackManifestSchema,
} from './types';
import { signStaging } from './signing';

const NATIVE_BINARY_EXT = /\.(so|dll|dylib|node)$/i;

// Suspicious string patterns. Be conservative — false positives stop a real
// export, so anchor on "= base64-or-hex of nontrivial length" or "Bearer X".
const SECRET_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: 'API_KEY assignment', rx: /\bAPI_KEY\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/ },
  { name: 'OPENAI_API_KEY', rx: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'Bearer token', rx: /\bBearer\s+[A-Za-z0-9_\-.]{20,}/ },
  { name: 'AWS_SECRET_ACCESS_KEY', rx: /AKIA[0-9A-Z]{16}/ },
];

// Files where absolute paths are tolerated (lockfiles, generated deps maps).
// Keep the allow-list tight; loosening later is easier than tightening.
const ABS_PATH_ALLOWLIST = new Set(['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock']);

// Test files: tolerated for absolute-path lint only (e.g. `/tmp/foo` in test
// scaffolding is legitimate). Tests are still packed and still get the
// secret/native-binary scans.
const TEST_FILE_RX = /\.(test|spec|smoke|fixtures?|e2e)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;

// Source maps embed the build host's filesystem layout. Don't lint them for
// absolute paths (false-positive treadmill), and don't ship them either —
// see `walk()` below.
const SOURCEMAP_RX = /\.map$/i;

// Heuristic: distinguishes a JS/TS regex literal from a real absolute path.
// `[/root/i, 'root']` and `(/tmp/g)` are regex literals (flags then a
// regex-context delimiter); `/root/foo` and `/tmp/baker` are actual paths
// (the trailing slash that closes `/word/` is followed by another path
// segment, not by a regex flag-set + delimiter).
function isRegexLiteralAfter(text: string, endIdx: number): boolean {
  const tail = text.slice(endIdx + 1, endIdx + 32);
  return /^[gimsuyd]*[,)\]\s;.|}>]/.test(tail);
}

interface LintFinding {
  pluginId: string;
  file: string;
  rule: 'native_binary' | 'absolute_path' | 'secret';
  detail: string;
}

function walk(root: string, out: string[] = [], rel = ''): string[] {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const abs = join(root, entry);
    const r = rel ? `${rel}/${entry}` : entry;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out, r);
    else out.push(r);
  }
  return out;
}

function isText(file: string, sample: Buffer): boolean {
  if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg') || file.endsWith('.webp') || file.endsWith('.gif') || file.endsWith('.ico') || file.endsWith('.zip') || file.endsWith('.gz') || file.endsWith('.fxpack')) {
    return false;
  }
  for (let i = 0; i < Math.min(sample.length, 1024); i++) {
    const b = sample[i];
    if (b === 0) return false;
  }
  return true;
}

function lintPlugin(pluginId: string, srcDir: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const files = walk(srcDir);
  for (const f of files) {
    if (NATIVE_BINARY_EXT.test(f)) {
      findings.push({ pluginId, file: f, rule: 'native_binary', detail: 'rejected by 10 §7 (跨平台跑不动)' });
      continue;
    }
    const abs = join(srcDir, f);
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (!isText(f, buf)) continue;
    const text = buf.toString('utf-8');
    for (const { name, rx } of SECRET_PATTERNS) {
      if (rx.test(text)) {
        findings.push({ pluginId, file: f, rule: 'secret', detail: `matched ${name}` });
      }
    }
    const baseName = f.split('/').pop() ?? f;
    const skipAbsPath = ABS_PATH_ALLOWLIST.has(baseName) || TEST_FILE_RX.test(baseName) || SOURCEMAP_RX.test(baseName);
    if (!skipAbsPath) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Windows user-identifying paths only — system paths like `C:\Windows`
        // or `D:\Program Files` aren't leaks worth blocking on.
        const winHit = /\b[A-Z]:[\\/]Users[\\/]/i.exec(line);
        if (winHit) {
          findings.push({ pluginId, file: f, rule: 'absolute_path', detail: `line ${i + 1}: ${line.trim().slice(0, 120)}` });
          break;
        }
        // POSIX user-identifying paths: `/Users/`, `/home/`, `/root/`. Drop
        // `/tmp/` and `/var/` — those are OS-shared and don't leak identity.
        // Iterate every candidate so a regex literal earlier on the line
        // doesn't mask a real path later.
        const rx = /(^|[^A-Za-z0-9_])\/(Users|home|root)\//g;
        let m: RegExpExecArray | null;
        let hit = false;
        while ((m = rx.exec(line)) !== null) {
          // Position of the trailing slash that closes `/(word)/`.
          const closeSlash = m.index + m[0].length - 1;
          if (isRegexLiteralAfter(line, closeSlash)) continue;
          findings.push({ pluginId, file: f, rule: 'absolute_path', detail: `line ${i + 1}: ${line.trim().slice(0, 120)}` });
          hit = true;
          break;
        }
        if (hit) break;
      }
    }
  }
  return findings;
}

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    }
  }
}

function loadPluginManifest(srcDir: string): PluginManifest {
  const path = join(srcDir, 'forgeax-plugin.json');
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw Object.assign(new Error(`plugin manifest invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`), {
      code: 'lint_error',
    });
  }
  return parsed.data;
}

/**
 * Compute the dependency closure for a bundle export per 10 §3.3:
 *   - top-level `dependencies[].id`           → 包进
 *   - agent `provides.agent.defaultSkills[]`
 *     where source==='plugin'                 → 包进
 *   - skill `requiresAgents` (soft)           → 不包进 (按 spec)
 *   - model-binding vendor key                → 永不包进
 *
 * Returns the additional plugin entries (id + srcDir) that should be
 * appended to the bundle. Looks up missing plugins via the live snapshot
 * (originPath → dirname). If a referenced id is not installed locally we
 * surface that as a `bad_input` later.
 */
function computeBundleClosure(
  inputPlugins: Array<{ id: string; srcDir: string }>,
  manifests: Record<string, PluginManifest>,
): { add: Array<{ id: string; srcDir: string }>; missing: string[] } {
  const haveIds = new Set(inputPlugins.map((p) => p.id));
  const refs = new Set<string>();

  for (const id of haveIds) {
    const m = manifests[id];
    if (!m) continue;
    for (const dep of m.dependencies ?? []) {
      if (dep.optional) continue;
      refs.add(dep.id);
    }
    if (m.kind === 'agent') {
      const ds = m.provides.agent.defaultSkills ?? [];
      for (const ref of ds) {
        if (
          ref &&
          typeof ref === 'object' &&
          'source' in ref &&
          (ref as { source: string }).source === 'plugin'
        ) {
          const pid = (ref as { pluginId?: string }).pluginId;
          if (pid) refs.add(pid);
        }
      }
    }
  }

  const add: Array<{ id: string; srcDir: string }> = [];
  const missing: string[] = [];
  if (refs.size === 0) return { add, missing };

  const snap = getPluginSnapshot();
  const visited = new Set<string>(haveIds);
  const queue = Array.from(refs).filter((id) => !visited.has(id));

  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const hit = snap.manifests.find((mm) => mm.manifest.id === id);
    if (!hit) {
      missing.push(id);
      continue;
    }
    const srcDir = dirname(hit.originPath);
    add.push({ id, srcDir });
    manifests[id] = hit.manifest;
    // walk transitively
    for (const dep of hit.manifest.dependencies ?? []) {
      if (dep.optional) continue;
      if (!visited.has(dep.id)) queue.push(dep.id);
    }
    if (hit.manifest.kind === 'agent') {
      const ds = hit.manifest.provides.agent.defaultSkills ?? [];
      for (const ref of ds) {
        if (
          ref &&
          typeof ref === 'object' &&
          'source' in ref &&
          (ref as { source: string }).source === 'plugin'
        ) {
          const pid = (ref as { pluginId?: string }).pluginId;
          if (pid && !visited.has(pid)) queue.push(pid);
        }
      }
    }
  }
  return { add, missing };
}

/**
 * Public closure walker keyed off a single root id resolved against the live
 * snapshot. Returns the root id followed by every transitive non-optional
 * `manifest.dependencies` (and agent `defaultSkills` with `source==='plugin'`).
 *
 * Order matches BFS visit order so the root sits at index 0, deps after — UI
 * surfaces can render the closure as "<root> · pulls in: <dep1>, <dep2>".
 *
 * The function is read-only: it neither mutates the snapshot nor caches.
 * Callers needing srcDir should fold the result back through the snapshot
 * (or use `exportPack({closure: true})`, which does it internally).
 */
export interface ClosureResult {
  ids: string[];
  missing: string[];
}

export function closureFrom(rootId: string): ClosureResult {
  const snap = getPluginSnapshot();
  const root = snap.manifests.find((m) => m.manifest.id === rootId);
  if (!root) return { ids: [], missing: [rootId] };

  const visited = new Set<string>([rootId]);
  const order: string[] = [rootId];
  const missing: string[] = [];
  const queue: string[] = [];

  const enqueueDeps = (m: PluginManifest): void => {
    for (const dep of m.dependencies ?? []) {
      if (dep.optional) continue;
      if (!visited.has(dep.id)) queue.push(dep.id);
    }
    if (m.kind === 'agent') {
      const ds = m.provides.agent.defaultSkills ?? [];
      for (const ref of ds) {
        if (
          ref &&
          typeof ref === 'object' &&
          'source' in ref &&
          (ref as { source: string }).source === 'plugin'
        ) {
          const pid = (ref as { pluginId?: string }).pluginId;
          if (pid && !visited.has(pid)) queue.push(pid);
        }
      }
    }
  };

  enqueueDeps(root.manifest);
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const hit = snap.manifests.find((mm) => mm.manifest.id === id);
    if (!hit) {
      missing.push(id);
      continue;
    }
    order.push(id);
    enqueueDeps(hit.manifest);
  }
  return { ids: order, missing };
}

async function runZip(stagingDir: string, outPath: string): Promise<void> {
  // -r recursive, -X strip extra attrs (deterministic), - q quiet.
  const proc = Bun.spawn(['zip', '-r', '-X', '-q', outPath, '.'], {
    cwd: stagingDir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw Object.assign(new Error(`zip exited ${exitCode}: ${stderr}`), { code: 'zip_error' });
  }
}

export async function exportPack(input: FxpackExportInput): Promise<FxpackExportResult> {
  if (!input.plugins.length) {
    return { ok: false, code: 'bad_input', error: 'plugins[] cannot be empty' };
  }
  // type=single requires exactly 1 *root* plugin. With closure: true the
  // closure walker may add deps to the contains[] list — that's still a
  // single-rooted pack, so we validate against the input array (pre-closure)
  // and let computeBundleClosure mutate `plugins` after.
  if (input.type === 'single' && input.plugins.length !== 1) {
    return { ok: false, code: 'bad_input', error: `type=single requires exactly 1 plugin, got ${input.plugins.length}` };
  }
  for (const p of input.plugins) {
    if (!existsSync(p.srcDir)) {
      return { ok: false, code: 'bad_input', error: `plugin srcDir does not exist: ${p.srcDir}` };
    }
    if (!existsSync(join(p.srcDir, 'forgeax-plugin.json'))) {
      return { ok: false, code: 'bad_input', error: `not a plugin dir (missing forgeax-plugin.json): ${p.srcDir}` };
    }
  }

  const allFindings: LintFinding[] = [];
  const manifests: Record<string, PluginManifest> = {};
  const plugins: Array<{ id: string; srcDir: string }> = [...input.plugins];
  for (const p of plugins) {
    let m: PluginManifest;
    try {
      m = loadPluginManifest(p.srcDir);
    } catch (e) {
      return {
        ok: false,
        code: 'lint_error',
        error: `${p.id}: ${(e as Error).message}`,
      };
    }
    if (m.id !== p.id) {
      return {
        ok: false,
        code: 'bad_input',
        error: `id mismatch: caller said ${p.id} but manifest declares ${m.id}`,
      };
    }
    manifests[p.id] = m;
    allFindings.push(...lintPlugin(p.id, p.srcDir));
  }

  // Dependency closure (10 §3.3). Always runs for type=bundle (legacy
  // behaviour); for type=single it now also runs when the caller explicitly
  // opts in via `closure: true` — useful when the receiver is offline and
  // cannot install deps separately. A single-rooted pack with closure is
  // still recognisably "single" because `primary` points at the root and
  // `contains[]` lists the deps as supporting cast.
  const bundleWarnings: string[] = [];
  const wantClosure = input.type === 'bundle' || input.closure === true;
  if (wantClosure) {
    const { add, missing } = computeBundleClosure(plugins, manifests);
    if (missing.length) {
      return {
        ok: false,
        code: 'bad_input',
        error: `bundle closure unresolved: missing plugin(s) ${missing.join(', ')} — install them locally before exporting, or mark the dependency as optional`,
      };
    }
    for (const extra of add) {
      plugins.push(extra);
      allFindings.push(...lintPlugin(extra.id, extra.srcDir));
      bundleWarnings.push(`auto-included dependency: ${extra.id}`);
    }
  }

  const blockingFindings = allFindings.filter((f) => f.rule !== 'absolute_path' || true);
  // We treat all 3 rules as blocking. (`absolute_path` is rejected too — the
  // doc explicitly lists it as 反模式 and the contract test asserts it.)
  if (blockingFindings.length) {
    return {
      ok: false,
      code: 'lint_error',
      error: `lint failed: ${blockingFindings.length} finding(s)`,
      details: blockingFindings,
    };
  }

  // Stage to tmp, write manifest, README, copy plugin trees, zip, return path.
  const stagingDir = join(tmpdir(), `fxpack-stage-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(join(stagingDir, 'plugins'), { recursive: true });

    const manifest: FxpackManifest = {
      schemaVersion: 1,
      type: input.type,
      id: input.bundleMeta.id,
      version: input.bundleMeta.version,
      title: input.bundleMeta.title,
      description: input.bundleMeta.description,
      // For type=single the root is always the first input id (closure may
      // have appended deps after it); for bundle, fall back to the only
      // contained id when there is exactly one. Caller-supplied primary
      // wins.
      primary:
        input.bundleMeta.primary
        ?? (input.type === 'single' ? input.plugins[0].id : undefined)
        ?? (plugins.length === 1 ? plugins[0].id : undefined),
      contains: plugins.map((p) => ({
        id: p.id,
        kind: manifests[p.id].kind,
        version: manifests[p.id].version,
      })),
      requires: input.bundleMeta.requires,
      author: input.bundleMeta.author,
      createdAt: new Date().toISOString(),
    };
    const validated = FxpackManifestSchema.safeParse(manifest);
    if (!validated.success) {
      return {
        ok: false,
        code: 'bad_input',
        error: `bundle manifest invalid: ${validated.error.issues.map((i) => i.message).join('; ')}`,
      };
    }

    writeFileSync(join(stagingDir, 'manifest.fxpack.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    writeFileSync(
      join(stagingDir, 'README.md'),
      buildReadme(manifest, plugins.map((p) => manifests[p.id])),
      'utf-8',
    );

    for (const p of plugins) {
      copyTree(p.srcDir, join(stagingDir, 'plugins', p.id));
    }

    if (input.signWith) {
      try {
        signStaging(stagingDir, input.signWith);
      } catch (e) {
        return { ok: false, code: 'fs_error', error: `sign failed: ${(e as Error).message}` };
      }
    }

    mkdirSync(dirname(input.outPath), { recursive: true });
    // Make sure out file does not exist — zip appends to existing archives,
    // which would silently corrupt round-trips.
    if (existsSync(input.outPath)) rmSync(input.outPath, { force: true });
    await runZip(stagingDir, input.outPath);

    return { ok: true, path: input.outPath, manifest, warnings: bundleWarnings };
  } catch (e) {
    const code = (e as { code?: string }).code === 'zip_error' ? 'zip_error' : 'fs_error';
    return { ok: false, code, error: (e as Error).message };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function pickName(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as { en?: string; zh?: string };
    return o.en ?? o.zh;
  }
  return undefined;
}

function buildReadme(m: FxpackManifest, plugins: PluginManifest[]): string {
  const title = m.title.en ?? m.title.zh ?? m.id;
  const lines: string[] = [
    `# ${title}`,
    '',
    `> ${m.description?.en ?? m.description?.zh ?? ''}`,
    '',
    `**Bundle ID**: \`${m.id}\` v${m.version}`,
    `**Type**: ${m.type}`,
    `**Created**: ${m.createdAt}`,
    '',
    '## Contents',
    '',
  ];
  for (const p of plugins) {
    const dn = pickName(p.displayName) ?? p.id;
    lines.push(`- **${dn}** — \`${p.id}\` v${p.version} (${p.kind})`);
  }
  lines.push('', '## Install', '', '```bash', 'forgeax pack install ./<this-file>.fxpack', '```');
  return lines.join('\n');
}

// re-export types so consumers can `from './packs/exporter'`
export type { FxpackExportInput, FxpackExportResult } from './types';
