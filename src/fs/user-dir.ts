/** User dir resolver — `~/.forgeax/` (formerly state-dir).
 *
 *  Single source of truth for the user-level data root. Override priority:
 *    1. `FORGEAX_USER_DIR` env var (test harness / multi-user per host)
 *    2. `~/.forgeax/`                 (production default)
 *
 *  Resolution is pure (no I/O, no fs.existsSync) — a missing user dir is a
 *  caller-side concern (mkdir on first write). */

import { homedir } from "node:os";
import { resolve, join } from "node:path";

export function resolveUserDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FORGEAX_USER_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".forgeax");
}
