// @desc Resolve gate script paths: "lib/gates/xxx" → builtin; other paths → contained inside the task folder.

import { join, isAbsolute, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathManagerAPI } from "#src/core/types.js";
import { taskDir } from "./task-dir.js";

// gate-resolver.ts lives at capabilities/task_collaboration/lib/gate-resolver.ts
// Builtin gate scripts live at capabilities/task_collaboration/lib/gates/.
// Using import.meta.url ensures correct resolution regardless of which capability
// layer (instance / team / agent) loads this module.
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_GATES_DIR = resolve(__dirname, "gates");

const BUILTIN_PREFIX = "lib/gates/";

export interface ResolvedScriptPath {
  /** Absolute path on the host where the script physically lives. */
  absPath: string;
  origin: "builtin" | "task";
}

/**
 * Resolve a script path declared in `task.gates`.
 *
 * Path origin: the folder containing `task.json` (`tasks/{id}/`).
 *  - `lib/gates/xxx.sh` → builtin gate (capabilities/task_collaboration/lib/gates/xxx.sh)
 *  - `gates/xxx.sh`     → task-local script (`tasks/{id}/gates/xxx.sh`)
 *  - other relative     → resolved against `tasks/{id}/`
 *
 * Containment is enforced: the resolved absolute path MUST live inside its origin
 * directory (builtin gates dir or task folder). Absolute paths are forbidden, and
 * any `..` traversal that would escape the origin throws. Throws are caught by
 * the gate evaluator and surfaced as a fail-with-reason leaf, so a misbehaving
 * task definition never crashes the watcher.
 */
export function resolveScriptPath(
  pm: PathManagerAPI,
  taskId: string,
  scriptPath: string,
): ResolvedScriptPath {
  if (scriptPath.length === 0) {
    throw new Error("gate script path is empty");
  }
  if (isAbsolute(scriptPath)) {
    throw new Error(`gate script '${scriptPath}' must be relative; absolute paths are forbidden`);
  }

  if (scriptPath.startsWith(BUILTIN_PREFIX)) {
    const rel = scriptPath.slice(BUILTIN_PREFIX.length);
    const candidate = resolve(BUILTIN_GATES_DIR, rel);
    assertContained(candidate, BUILTIN_GATES_DIR, scriptPath, "builtin gates dir");
    return { absPath: candidate, origin: "builtin" };
  }

  const taskAbs = taskDir(pm, taskId);
  const candidate = resolve(taskAbs, scriptPath);
  assertContained(candidate, taskAbs, scriptPath, "task folder");
  return { absPath: candidate, origin: "task" };
}

function assertContained(
  child: string,
  parent: string,
  scriptPath: string,
  parentLabel: string,
): void {
  const rel = relative(parent, child);
  // child === parent ⇒ rel === "" → reject (script can't be the directory itself)
  // rel starts with ".." ⇒ escapes parent → reject
  // isAbsolute(rel) ⇒ child is on a different device / scheme → reject
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`gate script '${scriptPath}' escapes ${parentLabel}`);
  }
}

export function builtinGatesDir(): string {
  return BUILTIN_GATES_DIR;
}
