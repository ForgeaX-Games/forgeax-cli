// Bundle forgeax-cli to node-runnable ESM JS (dist/).
//
// Why: forgeax-studio imports `forgeax-cli/kernel/forgeax-core-kernel` in-process
// (remote agent runtime). Shipped as a self-contained npm tarball (no forgeax-os
// checkout), it inlines the `@forgeax/*` workspace source (types, agent-runtime,
// platform-io, agent-host client) and leaves third-party deps external (installed
// via package.json `dependencies`).
//
// NOTE: cli spawns sibling *packages* at runtime — `@forgeax/agent-host/serve`
// and `@forgeax/forgeax-core/cli` — via import.meta.resolve. Those are NOT bundled
// here; they ship as their own tarballs and must be installed alongside. The
// `.mjs` MCP servers are runtime assets resolved by import.meta.dirname, so we
// copy them into dist preserving their src-relative layout.
import { build } from 'bun';
import { rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { Glob } from 'bun';
import { dirname, join } from 'node:path';

rmSync('./dist', { recursive: true, force: true });

/** Externalize every bare specifier except `@forgeax/*` (bundled from source). */
const externalizeNonForgeax = {
  name: 'externalize-non-forgeax',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const p = a.path;
      if (p.startsWith('.') || p.startsWith('/')) return; // relative → bundle
      if (p.startsWith('@/')) return; // internal tsconfig alias (@/* → src/*) → bundle
      if (p.startsWith('@forgeax/')) return; // workspace pkg / internal alias (@forgeax/bus) → bundle
      return { path: p, external: true }; // third-party + node: → external
    });
  },
};

const res = await build({
  entrypoints: ['./src/kernel/forgeax-core-kernel.ts', './src/index.ts'],
  outdir: './dist',
  root: './src',
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'linked',
  plugins: [externalizeNonForgeax],
});

for (const l of res.logs) console.log(String(l));
if (!res.success) process.exit(1);

// Copy runtime .mjs assets (MCP stdio servers) preserving src-relative paths so
// `resolve(import.meta.dirname, '…/mcp/*.mjs')` keeps resolving inside dist/.
const glob = new Glob('**/*.mjs');
let assets = 0;
for await (const rel of glob.scan({ cwd: './src' })) {
  const dest = join('./dist', rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join('./src', rel), dest);
  assets++;
}

// Minimal hand-written type shims. forgeax-studio consumes these loosely
// (`as unknown as Os2Kernel`), so full cross-package .d.ts bundling is unnecessary.
writeFileSync(
  './dist/kernel/forgeax-core-kernel.d.ts',
  [
    '// Minimal type shim (loosely typed on purpose — the consumer casts).',
    'export declare function registerForgeaxCoreKernel(opts: { hostBridge: unknown }): void;',
    'export declare function getKernel(name: string): unknown;',
    '',
  ].join('\n'),
);
writeFileSync('./dist/index.d.ts', 'export {};\n');

console.log('[build] forgeax-cli → dist/ (%d js + %d mjs assets + 2 d.ts)', res.outputs.length, assets);
