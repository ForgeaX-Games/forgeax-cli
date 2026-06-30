/** Single source of truth for the path-segment traversal guard.
 *
 *  Both PathManager (framework paths) and SessionLayout implementations
 *  (session roots, in cli and in the product shell) accept user-provided
 *  names (slug / agent name / sid) as path segments. Keeping the guard in
 *  one place means the directory-traversal defense can never drift between
 *  the cli layout and a host's injected layout. */

import { isAbsolute } from "node:path";

/** Reject path segments that would escape their parent (slashes, `..`, abs).
 *  The error message is load-bearing — callers/tests match on the prefix
 *  "PathManager: unsafe path segment". */
export function safeSegment(name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name === ".." || isAbsolute(name)) {
    throw new Error(`PathManager: unsafe path segment ${JSON.stringify(name)}`);
  }
  return name;
}
