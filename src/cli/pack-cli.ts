/**
 * forgeax-pack — author/distribute CLI for the .fxpack format.
 *
 *   forgeax-pack pack <pluginDir> [-o out.fxpack] [--closure]
 *   forgeax-pack inspect <pack.fxpack>
 *   forgeax-pack install <pack.fxpack> [--layer L1|L2] [--policy skip|overwrite|rename] [--ack-unsigned]
 *   forgeax-pack list [--layer L1|L2]
 *
 * Subcommands call the in-process exporter/importer modules directly — no
 * running daemon required. Useful for shipping agent packs offline (zip on
 * one host, hand the .fxpack file off, install on another).
 *
 * `pack --closure` and `install` need the in-process plugin registry loaded
 * so dependency closure / conflict detection has data to work with; we call
 * `reloadPlugins()` lazily on first use.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { exportPack, closureFrom } from '../packs/exporter';
import { inspectPack, installPack } from '../packs/importer';
import { readInstalled } from '../packs/ledger';
import { reloadPlugins } from '../plugins/registry';
import { defaultProjectRoot } from '../api/lib/safe-path';

interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '-o' || a === '--out') {
      flags.out = rest[++i];
    } else if (a === '--layer') {
      flags.layer = rest[++i];
    } else if (a === '--policy') {
      flags.policy = rest[++i];
    } else if (a === '--closure') {
      flags.closure = true;
    } else if (a === '--ack-unsigned') {
      flags.ackUnsigned = true;
    } else if (a === '--root') {
      flags.root = rest[++i];
    } else if (a.startsWith('--')) {
      flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

function readPluginManifestSync(srcDir: string): { id: string; version: string; kind: string } {
  const raw = JSON.parse(readFileSync(join(srcDir, 'forgeax-plugin.json'), 'utf-8'));
  return { id: String(raw.id), version: String(raw.version ?? '0.1.0'), kind: String(raw.kind ?? 'agent') };
}

async function cmdPack(args: ParsedArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) {
    process.stderr.write('Usage: forgeax-pack pack <pluginDir> [-o out.fxpack] [--closure]\n');
    process.exit(2);
  }
  const srcDir = resolve(dir);
  if (!existsSync(join(srcDir, 'forgeax-plugin.json'))) {
    process.stderr.write(`error: ${srcDir}/forgeax-plugin.json not found\n`);
    process.exit(1);
  }
  const m = readPluginManifestSync(srcDir);
  const outPath = args.flags.out
    ? resolve(String(args.flags.out))
    : resolve(process.cwd(), `${basename(srcDir)}-${m.version}.fxpack`);

  const plugins: Array<{ id: string; srcDir: string }> = [{ id: m.id, srcDir }];
  if (args.flags.closure) {
    await reloadPlugins();
    const closure = closureFrom(m.id);
    if (closure.missing.length) {
      process.stderr.write(`warn: closure missing ids: ${closure.missing.join(', ')}\n`);
    }
    const snap = (await import('../plugins/registry')).getPluginSnapshot();
    for (const depId of closure.ids) {
      if (depId === m.id) continue;
      const hit = snap.manifests.find((mm) => mm.manifest.id === depId);
      if (hit) plugins.push({ id: depId, srcDir: resolve(hit.originPath, '..') });
    }
  }

  const result = await exportPack({
    type: plugins.length > 1 ? 'bundle' : 'single',
    plugins,
    outPath,
    bundleMeta: {
      id: m.id,
      version: m.version,
      title: { en: m.id },
    },
  });

  if (!result.ok) {
    process.stderr.write(`pack failed (${result.code}): ${result.error}\n`);
    if (result.details) process.stderr.write(`${JSON.stringify(result.details, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`packed: ${result.path}\n`);
  if (result.warnings.length) {
    for (const w of result.warnings) process.stdout.write(`  warn: ${w}\n`);
  }
}

async function cmdInspect(args: ParsedArgs): Promise<void> {
  const file = args.positional[0];
  if (!file) {
    process.stderr.write('Usage: forgeax-pack inspect <pack.fxpack>\n');
    process.exit(2);
  }
  const result = await inspectPack(resolve(file));
  if (!result.ok) {
    process.stderr.write(`inspect failed (${result.code}): ${result.error}\n`);
    process.exit(1);
  }
  const { manifest, trust } = result;
  process.stdout.write(`id:        ${manifest.id} (${manifest.type})\n`);
  process.stdout.write(`version:   ${manifest.version}\n`);
  process.stdout.write(`title:     ${manifest.title.zh ?? manifest.title.en ?? '-'}\n`);
  process.stdout.write(`signed:    ${trust.signed ? `yes (${trust.signerTrust ?? 'unknown'})` : 'no'}\n`);
  if (trust.signerLabel) process.stdout.write(`signer:    ${trust.signerLabel}\n`);
  process.stdout.write(`contains:\n`);
  for (const c of manifest.contains) {
    process.stdout.write(`  - ${c.id} (${c.kind}@${c.version})\n`);
  }
  if (Object.keys(trust.permissions).length) {
    process.stdout.write(`permissions:\n`);
    for (const [pid, perms] of Object.entries(trust.permissions)) {
      process.stdout.write(`  ${pid}: ${(perms ?? []).join(', ') || '(none)'}\n`);
    }
  }
  if (trust.conflicts.length) {
    process.stdout.write(`conflicts:\n`);
    for (const c of trust.conflicts) {
      process.stdout.write(`  - ${c.id}: ${c.existingLayer}@${c.existingVersion} → ${c.newVersion}\n`);
    }
  }
  if (trust.warnings.length) {
    process.stdout.write(`warnings:\n`);
    for (const w of trust.warnings) process.stdout.write(`  - ${w}\n`);
  }
}

async function cmdInstall(args: ParsedArgs): Promise<void> {
  const file = args.positional[0];
  if (!file) {
    process.stderr.write('Usage: forgeax-pack install <pack.fxpack> [--layer L1|L2] [--policy skip|overwrite|rename] [--ack-unsigned]\n');
    process.exit(2);
  }
  const layer = (args.flags.layer === 'L2' ? 'L2' : 'L1') as 'L1' | 'L2';
  const destRoot = layer === 'L1' ? homedir() : (args.flags.root ? resolve(String(args.flags.root)) : defaultProjectRoot());
  const policy = (args.flags.policy as 'skip' | 'overwrite' | 'rename' | undefined) ?? 'skip';

  await reloadPlugins(); // populate snapshot for conflict detection
  const result = await installPack({
    zipPath: resolve(file),
    destRoot,
    destLayer: layer,
    conflictPolicy: policy,
    userAcknowledgedUnsigned: Boolean(args.flags.ackUnsigned),
  });
  if (!result.ok) {
    process.stderr.write(`install failed (${result.code}): ${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`installed to ${layer} (${destRoot}):\n`);
  for (const id of result.installed) process.stdout.write(`  + ${id}\n`);
  for (const id of result.skipped) process.stdout.write(`  = ${id} (skipped, already present)\n`);
  for (const [id, slug] of Object.entries(result.renamed)) process.stdout.write(`  ~ ${id} → ${slug}\n`);
  await reloadPlugins();
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const layer = (args.flags.layer === 'L2' ? 'L2' : args.flags.layer === 'L1' ? 'L1' : null) as 'L1' | 'L2' | null;
  const roots: Array<{ layer: 'L1' | 'L2'; root: string }> = [];
  if (!layer || layer === 'L1') roots.push({ layer: 'L1', root: homedir() });
  if (!layer || layer === 'L2') roots.push({ layer: 'L2', root: defaultProjectRoot() });

  for (const { layer: lyr, root } of roots) {
    process.stdout.write(`# ${lyr} · ${root}\n`);
    const ledger = readInstalled(root);
    const dir = join(root, '.forgeax', 'plugins');
    const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => {
      try { return statSync(join(dir, f)).isDirectory(); } catch { return false; }
    }) : [];
    if (!ledger.length && !onDisk.length) {
      process.stdout.write('  (empty)\n');
      continue;
    }
    const ledgerById = new Map(ledger.map((e) => [e.id, e]));
    for (const slug of onDisk) {
      const manifestPath = join(dir, slug, 'forgeax-plugin.json');
      if (!existsSync(manifestPath)) continue;
      let id = slug;
      let version = '?';
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        id = String(raw.id ?? slug);
        version = String(raw.version ?? '?');
      } catch { /* skip parse errors */ }
      const fromLedger = ledgerById.get(id);
      const ts = fromLedger?.ts ? ` (installed ${fromLedger.ts})` : '';
      process.stdout.write(`  - ${id}@${version} → ${slug}${ts}\n`);
    }
  }
}

function help(): void {
  process.stdout.write(`forgeax-pack — agent pack author/distribute CLI

Usage:
  forgeax-pack pack <pluginDir> [-o out.fxpack] [--closure]
                              build a .fxpack from a plugin directory
  forgeax-pack inspect <pack.fxpack>
                              show manifest, trust state, and conflicts
  forgeax-pack install <pack.fxpack> [--layer L1|L2] [--policy <skip|overwrite|rename>]
                              [--ack-unsigned] [--root <projectRoot>]
                              install a pack to L1 (~/.forgeax) or L2 (<projectRoot>/.forgeax)
  forgeax-pack list [--layer L1|L2]
                              show installed plugins on disk and in the install ledger
`);
}

export async function runPackCLI(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  switch (parsed.cmd) {
    case 'pack':    return cmdPack(parsed);
    case 'inspect': return cmdInspect(parsed);
    case 'install': return cmdInstall(parsed);
    case 'list':    return cmdList(parsed);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      help();
      return;
    default:
      process.stderr.write(`unknown subcommand: ${parsed.cmd}\n\n`);
      help();
      process.exit(2);
  }
}

if (import.meta.main) {
  runPackCLI(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
