/** SessionLayout — the injection seam that decouples "where a session's state
 *  tree lives / how sessions are enumerated" from the generic session/agent
 *  machinery.
 *
 *  cli/core only ever call this interface; they do NOT know about "game".
 *  The product shell (packages/server, studio) injects a concrete layout via
 *  `ProductContext.sessionLayoutFactory(root)` → `initPathManager({ layout })`
 *  (a factory keyed by project root so a workspace switch can rebuild it). When no
 *  layout is injected, PathManager falls back to `FlatSessionLayout`, which
 *  reproduces the pre-seam behavior (sessions under `<userRoot>/sessions/`) —
 *  this is what lets forgeax-cli run as a standalone, game-agnostic CLI.
 *
 *  Operations:
 *    - `allocate`        the ONLY writer — establishes a new session's home
 *                        (studio = bind to the current active game), creates the
 *                        dir, returns its roots. Path-as-SSOT: after allocate the
 *                        binding lives in the on-disk path, not a stored field.
 *    - `sessionRoot`     state-tree root (WAL/logs/checkpoints). Pure read.
 *    - `sessionWorkDir`  agent working directory (studio = the bound game dir;
 *                        generic = projectRoot). Pure read.
 *    - `listSessionIds`  enumeration. Pure read. */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { safeSegment } from "./safe-segment.js";

export interface SessionLayout {
  /** Establish a brand-new session's home and return its roots. The single
   *  writer: it decides the binding (studio = current active game), creates the
   *  directory, and from then on the binding is recoverable from the path alone.
   *  `sessionRoot`/`sessionWorkDir` for that sid are only meaningful after this
   *  (or for a session already present on disk). */
  allocate(sid: string): { sessionRoot: string; workDir: string };
  /** Absolute root of a session's state tree (WAL / logs / checkpoints.jsonl
   *  all live under it). The `sid` is treated as a single path segment and
   *  guarded against traversal by the implementation. */
  sessionRoot(sid: string): string;
  /** The agent's working directory for this session. studio = the bound game's
   *  directory (permanent binding); generic = projectRoot. */
  sessionWorkDir(sid: string): string;
  /** Enumerate the ids of every session currently on disk. Implementations
   *  return raw directory names; callers filter (e.g. by presence of
   *  session.json) as they already do. */
  listSessionIds(): string[];

  /** Optional (studio) — backward compat with pre-PR2 sessions. `true` when `sid`
   *  is currently stored in a *legacy* location (home / flat project sessions),
   *  not yet under the project's games tree. Read-compat surfaces such sessions;
   *  a write triggers `migrateLegacyIntoProject`. Generic layouts omit it (no
   *  legacy notion → always project-local). */
  isLegacySession?(sid: string): boolean;
  /** Optional (studio) — move a legacy session's WHOLE directory into the project
   *  (`games/<slug>/sessions/<sid>/`, slug = its original bound game) and rebind,
   *  so all new + old records live under the current project. Precondition: the
   *  caller has released any open handles on the session. Idempotent: no-op when
   *  the session is already project-local. */
  migrateLegacyIntoProject?(sid: string): void;

  /** Optional (studio) — resolve the "current scope" slug for a session
   *  (studio = the session's bound / active game). This is the SINGLE scope
   *  authority cli reads from (compose-turn-request fallback, host-tool bridge,
   *  …) instead of a parallel `getActiveGame` import or a separate scopeResolver
   *  seam (SSOT, Stage A §3.3). Generic/flat layouts omit it → no scope (global).
   *  `sessionId` undefined ⇒ the layout's notion of the *currently active* scope
   *  (studio = active-game), which is exactly the old `getActiveGame()` fallback.
   *  `root` (optional) ⇒ resolve the active scope under an explicit project root
   *  rather than the default one (used by workspace activation, which queries the
   *  just-activated workspace dir). */
  resolveScope?(sessionId?: string, root?: string): string | undefined;
}

/** Shared scan: direct child directory names of `sessionsRoot`. Returns `[]`
 *  when the root is absent/unreadable (a fresh install has no sessions yet). */
export function listSessionDirs(sessionsRoot: string): string[] {
  if (!existsSync(sessionsRoot)) return [];
  try {
    return readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Flat layout: sessions live directly under `<sessionsRoot>/<sid>/`.
 *  Reused for two roles that are structurally identical today:
 *    - cli generic default → `sessionsRoot = <userRoot>/sessions` (home);
 *      behavior-equivalent to the pre-seam SessionLayer.
 *    - studio shell (PR1)  → `sessionsRoot = <projectRoot>/.forgeax/sessions`
 *      (project-local), which collapses the WAL ↔ trace/log split.
 *  PR2 introduces a distinct game-nested layout (`games/<slug>/sessions/<sid>`)
 *  in the product shell; that one is genuinely different and gets its own class. */
export class FlatSessionLayout implements SessionLayout {
  /** @param sessionsRoot parent dir of all `<sid>/` state trees.
   *  @param workDir agent working directory (generic = projectRoot). */
  constructor(private readonly sessionsRoot: string, private readonly workDir: string) {}
  allocate(sid: string): { sessionRoot: string; workDir: string } {
    const root = this.sessionRoot(sid);
    mkdirSync(root, { recursive: true });
    return { sessionRoot: root, workDir: this.workDir };
  }
  sessionRoot(sid: string): string {
    return join(this.sessionsRoot, safeSegment(sid));
  }
  sessionWorkDir(_sid: string): string {
    return this.workDir;
  }
  listSessionIds(): string[] {
    return listSessionDirs(this.sessionsRoot);
  }
}
