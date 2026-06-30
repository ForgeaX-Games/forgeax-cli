#!/usr/bin/env bun
/** Stage A CI guard — keeps forgeax-cli business-agnostic (铁律②: cli 零业务耦合).
 *
 *  Fails if game-business coupling leaks (back) into cli/src:
 *    HARD (never, anywhere — including comments): `buildGameCharter`, `@ag-ui`,
 *         `forge.json` — these are unambiguous game-business / ghost-dep markers.
 *    SOFT (`.forgeax/games`): forbidden in CODE, but tolerated in comments and in
 *         the documented ALLOWLIST below (generic infra defaults + business still
 *         pending its own migration — see docs/features/forgeax-cli-stage-a-decouple.md).
 *
 *  Run: `bun run check:business-agnostic` (also wired into the cli gate). */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

// Documented residual `.forgeax/games` in CODE — staged follow-ups, NOT core
// orchestration. Each is a path-default / business module awaiting its own move.
const SOFT_ALLOWLIST = new Set([
  'api/lib/watcher.ts',                  // generic watcher's default watch path
  'lib/wb-bgm/tool-specs.ts',            // bgm tool-spec strings (builtin bgm kit coupling — deferred)
  'kernel/mcp/forgeax-tools-server.mjs', // game host-tools MCP server (hostTools migration — deferred)
  'kernel/forgeax-builtin-tools.ts',     // game host-tools host-side impl (list_games …) — same hostTools migration, deferred
]);

const HARD = [
  { re: /buildGameCharter/, label: 'buildGameCharter (game charter builder — lives in the shell now)' },
  { re: /@ag-ui/, label: '@ag-ui (removed ghost dependency)' },
  { re: /forge\.json/, label: 'forge.json (game manifest — game business)' },
];
const SOFT = { re: /\.forgeax\/games/, label: '.forgeax/games (hardcoded game path — inject via PathManager/policy)' };

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mjs|js)$/.test(e)) yield p;
  }
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    for (const h of HARD) {
      if (h.re.test(line)) violations.push(`${rel}:${i + 1}  [HARD] ${h.label}`);
    }
    if (SOFT.re.test(line) && !isComment(line) && !SOFT_ALLOWLIST.has(rel)) {
      violations.push(`${rel}:${i + 1}  [SOFT] ${SOFT.label}`);
    }
  });
}

if (violations.length) {
  console.error('✗ forgeax-cli business-agnostic guard FAILED — game-business coupling in cli/src:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s). Move the business into the product shell (server) or inject it via a seam.`);
  process.exit(1);
}
console.log('✓ forgeax-cli business-agnostic guard passed (no game-business coupling in cli/src).');
