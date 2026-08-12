// Bundle @forgeax/cli to node-runnable ESM JS (dist/).
//
// Why: forgeax-studio's remote runtime spawns `@forgeax/cli/serve --serve`
// as a subprocess via import.meta.resolve. Shipped as a self-contained npm tarball
// (no forgeax-os checkout), it must run on plain node (no tsx). We inline the
// the published `@forgeax/agent-runtime` and `@forgeax/types` npm dependencies and
// leave third-party deps external (installed via package.json `dependencies`).
import { build } from 'bun';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = process.env.FORGEAX_DIST_DIR ?? './dist';
const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
const contractPackageNames = ['@forgeax/types', '@forgeax/agent-runtime'];
const buildInputs = Object.fromEntries(
  contractPackageNames.map((name) => [name, packageJson.devDependencies[name]]),
);

rmSync(distDir, { recursive: true, force: true });

/** Bundle ForgeaX npm dependencies; leave third-party and platform imports external. */
const externalizeNonForgeax = {
  name: 'externalize-non-forgeax',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const p = a.path;
      if (p.startsWith('.') || p.startsWith('/')) return; // relative → bundle
      if (p.startsWith('@forgeax/')) return; // published ForgeaX package → bundle
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
  outdir: distDir,
  root: './src',
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'linked',
  plugins: [externalizeNonForgeax],
});

for (const l of res.logs) console.log(String(l));
if (!res.success) process.exit(1);

// Published bin must run on plain Node (npm global install has no Bun).
// Source keeps `#!/usr/bin/env bun` for local `bun src/cli/main.ts`.
const cliMain = join(distDir, 'cli/main.js');
const cliSrc = readFileSync(cliMain, 'utf8');
writeFileSync(
  cliMain,
  cliSrc.replace(/^#!\/usr\/bin\/env bun\b/, '#!/usr/bin/env node'),
);
chmodSync(cliMain, 0o755);
writeFileSync(join(distDir, 'build-inputs.json'), `${JSON.stringify(buildInputs, null, 2)}\n`);

console.log('[build] @forgeax/cli → %s (%d files)', distDir, res.outputs.length);
