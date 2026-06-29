// Explicit "active character" binding — the SSOT for "which character the
// user most recently produced / is handing off between workbenches" within a
// given game.
//
// Why this exists (2026-06-01, "走文件连通"): the pipeline
//   wb-character (design) → wb-anim (animate) → wb-skill (vfx) → wb-reel (output)
// used to hand the selected charId between iframes via a transient
// localStorage key (`forgeax:anim-handoff`). That signal is lost on reload and
// is not visible to server-side / AI consumers. The actual character DATA was
// already on disk (`.forgeax/games/<slug>/characters/<charId>/manifest.json`);
// only the *pointer* ("which charId to read") lived in localStorage.
//
// This module persists that pointer as a file, mirroring active-game.json:
//   <projectRoot>/.forgeax/games/<slug>/active-character.json
//     → { version: 1, charId, role }
// Downstream workbenches read it on mount instead of waiting for a postMessage,
// so the handoff survives reloads, works across iframes, and is inspectable by
// AI / tooling. localStorage is kept only as a best-effort fast-path signal.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Mirror of GAME_SLUG_RE / character id grammar used elsewhere. Duplicated to
// keep this module dependency-light (no circular imports).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const CHAR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export type ActiveCharacterRole = 'hero' | 'npc' | 'monster' | 'vehicle';

interface ActiveCharacterStore {
  version: 1;
  charId: string;
  role: ActiveCharacterRole;
  /** ISO timestamp of the last write — useful for debugging stale pointers. */
  updatedAt: string;
}

function isRole(v: unknown): v is ActiveCharacterRole {
  return v === 'hero' || v === 'npc' || v === 'monster' || v === 'vehicle';
}

export function activeCharacterFile(root: string, slug: string): string {
  return resolve(root, '.forgeax', 'games', slug, 'active-character.json');
}

function charDirExists(root: string, slug: string, charId: string): boolean {
  return existsSync(resolve(root, '.forgeax/games', slug, 'characters', charId));
}

/**
 * Read the explicitly-recorded active character for a game, or `null` when
 * none is set or it points at a character dir that no longer exists.
 */
export function getActiveCharacter(
  root: string,
  slug: string,
): { charId: string; role: ActiveCharacterRole } | null {
  if (!SLUG_RE.test(slug)) return null;
  const file = activeCharacterFile(root, slug);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ActiveCharacterStore>;
    if (parsed.version !== 1) return null;
    const charId = typeof parsed.charId === 'string' ? parsed.charId : '';
    if (!charId || !CHAR_ID_RE.test(charId)) return null;
    // A deleted character shouldn't pin the pointer forever.
    if (!charDirExists(root, slug, charId)) return null;
    const role = isRole(parsed.role) ? parsed.role : 'hero';
    return { charId, role };
  } catch {
    return null;
  }
}

/**
 * Record the user's active character for a game. Called by wb-character right
 * after it writes a character's manifest (the produce side). No-op-safe:
 * invalid slug/charId are ignored rather than throwing.
 */
export function setActiveCharacter(
  root: string,
  slug: string,
  charId: string,
  role: ActiveCharacterRole = 'hero',
): void {
  if (!SLUG_RE.test(slug) || !CHAR_ID_RE.test(charId)) return;
  const file = activeCharacterFile(root, slug);
  mkdirSync(dirname(file), { recursive: true });
  const store: ActiveCharacterStore = {
    version: 1,
    charId,
    role: isRole(role) ? role : 'hero',
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Drop the pointer IFF it currently points at `charId` (e.g. character deleted).
 * No-op when absent or pointing elsewhere.
 */
export function clearActiveCharacterIf(root: string, slug: string, charId: string): void {
  const cur = getActiveCharacter(root, slug);
  if (cur?.charId !== charId) return;
  try {
    rmSync(activeCharacterFile(root, slug));
  } catch {
    /* already gone — fine */
  }
}
