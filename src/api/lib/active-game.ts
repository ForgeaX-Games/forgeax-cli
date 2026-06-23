// Explicit "active game" binding — the SSOT for "which game is the user
// currently working on" within a workspace.
//
// Why this exists (root-fix 2026-05-29): the active game used to be derived
// purely from `detectActiveSlug()` — most-recently-mtime'd .forgeax/games/<slug>/
// dir. That heuristic is fragile: any `touch`, scaffold copy, or stray write
// reorders it, so the agent CLI's working directory + the system-prompt scope
// could silently point at the wrong game. Worse, nothing ever *recorded* the
// user's explicit choice (create a game / pick a game in the switcher), so a
// session's cli stayed glued to whatever game happened to be newest at boot.
//
// This module persists the user's explicit selection at
//   <projectRoot>/.forgeax/active-game.json  → { version: 1, slug }
// `getActiveGame()` returns that slug when it still resolves to a real game
// dir, and only falls back to the mtime heuristic when no explicit binding
// exists (fresh workspace / pre-existing installs). Consumers (claude-code
// provider, /api/workbench endpoints, session defaultDir bootstrap) read this
// single function so they cannot drift.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { detectActiveSlug } from './active-slug';

// Mirror of workbench.ts GAME_SLUG_RE. Duplicated (not imported) to avoid a
// circular import: workbench.ts imports this module, and importing its slug
// regex back would close the cycle. Keep the two in sync.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

interface ActiveGameStore {
  version: 1;
  slug: string;
}

export function activeGameFile(root: string): string {
  return resolve(root, '.forgeax', 'active-game.json');
}

function gameDirExists(root: string, slug: string): boolean {
  return existsSync(resolve(root, '.forgeax/games', slug));
}

/** Read the explicitly-recorded active game slug, or `undefined` if none. */
function readExplicit(root: string): string | undefined {
  const file = activeGameFile(root);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ActiveGameStore>;
    if (parsed.version !== 1) return undefined;
    const slug = typeof parsed.slug === 'string' ? parsed.slug : undefined;
    if (!slug || !SLUG_RE.test(slug)) return undefined;
    return slug;
  } catch {
    return undefined;
  }
}

/**
 * The active game slug for a workspace.
 *
 * Resolution order:
 *   1. explicit binding (active-game.json) — IF the slug still points at a
 *      real .forgeax/games/<slug>/ dir (a deleted game shouldn't pin forever);
 *   2. else the legacy most-recent-mtime heuristic (detectActiveSlug);
 *   3. else `undefined` (no games at all).
 *
 * @param root - studio/instance project root (typically `defaultProjectRoot()`)
 */
export function getActiveGame(root: string): string | undefined {
  const explicit = readExplicit(root);
  if (explicit && gameDirExists(root, explicit)) return explicit;
  return detectActiveSlug(root);
}

/**
 * Record the user's explicit active-game choice. Called when a game is created
 * or picked in the switcher. No-op-safe: invalid slugs are ignored rather than
 * throwing (callers validate first; this is a defensive last line).
 */
export function setActiveGame(root: string, slug: string): void {
  if (!SLUG_RE.test(slug)) return;
  const file = activeGameFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const store: ActiveGameStore = { version: 1, slug };
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Drop the explicit binding IFF it currently points at `slug`. Called when a
 * game is deleted so a removed slug doesn't keep `getActiveGame` pinned to a
 * now-missing dir (which would otherwise force the mtime fallback to resolve
 * something — usually fine, but the binding should reflect reality). After this
 * `getActiveGame` re-derives from the remaining games via the mtime heuristic.
 * No-op when the binding is absent or points elsewhere.
 */
export function clearActiveGameIf(root: string, slug: string): void {
  if (readExplicit(root) !== slug) return;
  try {
    rmSync(activeGameFile(root));
  } catch {
    /* already gone — fine */
  }
}
