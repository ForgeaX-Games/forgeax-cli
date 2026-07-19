// Bundle @forgeax/cli to node-runnable ESM JS (dist/).
//
// Why: forgeax-studio's remote runtime spawns `@forgeax/cli/serve --serve`
// as a subprocess via import.meta.resolve. Shipped as a self-contained npm tarball
// (no forgeax-os checkout), it must run on plain node (no tsx). We inline the
// `@forgeax/*` workspace source (agent-runtime, types) and leave third-party deps
// external (installed via package.json `dependencies`).
import { build } from 'bun';
import { rmSync } from 'node:fs';

rmSync('./dist', { recursive: true, force: true });

/** Externalize every bare specifier except `@forgeax/*` (bundled from source). */
const externalizeNonForgeax = {
  name: 'externalize-non-forgeax',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const p = a.path;
      if (p.startsWith('.') || p.startsWith('/')) return; // relative → bundle
      if (p.startsWith('@forgeax/')) return; // workspace → bundle
      return { path: p, external: true }; // third-party + node: → external
    });
  },
};

const res = await build({
  entrypoints: [
    './src/cli/main.ts',
    './src/index.ts',
    './src/events/index.ts',
    './src/history/index.ts',
    './src/inject/types.ts',
  ],
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
console.log('[build] @forgeax/cli → dist/ (%d files)', res.outputs.length);
