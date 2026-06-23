// @desc Single-task directory CRUD: load/save task.json + state.json + per-task in-process mutex.

import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { PathManagerAPI } from "#src/core/types.js";
import type { TaskFile, TaskState } from "./task-types.js";

/** team/shared-workspace/tasks/ */
export function tasksRoot(pm: PathManagerAPI): string {
  return join(pm.team().sharedWorkspace(), "tasks");
}

/** team/shared-workspace/tasks/{id}/ */
export function taskDir(pm: PathManagerAPI, taskId: string): string {
  return join(tasksRoot(pm), taskId);
}

export function taskFilePath(pm: PathManagerAPI, taskId: string): string {
  return join(taskDir(pm, taskId), "task.json");
}

export function taskStatePath(pm: PathManagerAPI, taskId: string): string {
  return join(taskDir(pm, taskId), "state.json");
}

export function taskLogPath(pm: PathManagerAPI, taskId: string): string {
  return join(taskDir(pm, taskId), "log.jsonl");
}

export function taskGatesDir(pm: PathManagerAPI, taskId: string): string {
  return join(taskDir(pm, taskId), "gates");
}

export function ensureTaskDir(pm: PathManagerAPI, taskId: string): void {
  getSandboxFs().mkdirSync(taskDir(pm, taskId));
}

export function taskExists(pm: PathManagerAPI, taskId: string): boolean {
  return getSandboxFs().existsSync(taskFilePath(pm, taskId));
}

export function listTaskIds(pm: PathManagerAPI): string[] {
  const fs = getSandboxFs();
  const root = tasksRoot(pm);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => {
      const s = fs.statSync(join(root, name));
      return s !== null && s.isDirectory && fs.existsSync(join(root, name, "task.json"));
    });
}

export function readTaskFile(pm: PathManagerAPI, taskId: string): TaskFile {
  const raw = getSandboxFs().readTextSync(taskFilePath(pm, taskId));
  return JSON.parse(raw) as TaskFile;
}

export function writeTaskFile(pm: PathManagerAPI, taskId: string, task: TaskFile): void {
  ensureTaskDir(pm, taskId);
  getSandboxFs().writeTextSync(taskFilePath(pm, taskId), JSON.stringify(task, null, 2) + "\n");
}

export function readTaskState(pm: PathManagerAPI, taskId: string): TaskState {
  const raw = getSandboxFs().readTextSync(taskStatePath(pm, taskId));
  return JSON.parse(raw) as TaskState;
}

export function writeTaskState(pm: PathManagerAPI, taskId: string, state: TaskState): void {
  ensureTaskDir(pm, taskId);
  state.updatedAt = new Date().toISOString();
  getSandboxFs().writeTextSync(taskStatePath(pm, taskId), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Whitelist for gate script filenames. Plain basename only, no path separators,
 * no `..`, must end in `.sh`. This is the **single source of truth** — tools and
 * lib helpers all funnel through `ensureSafeGateFilename`.
 */
export const SAFE_GATE_FILENAME_RE = /^[A-Za-z0-9_.-]+\.sh$/;

export function ensureSafeGateFilename(filename: string): void {
  if (filename.length === 0 || filename.length > 80) {
    throw new Error(`unsafe gate filename '${filename}' (length must be 1..80)`);
  }
  if (!SAFE_GATE_FILENAME_RE.test(filename)) {
    throw new Error(
      `unsafe gate filename '${filename}' — must match ${SAFE_GATE_FILENAME_RE.source} ` +
      `(plain basename, no path separators, no '..')`,
    );
  }
}

export function writeGateScript(pm: PathManagerAPI, taskId: string, filename: string, content: string): void {
  ensureSafeGateFilename(filename);
  const fs = getSandboxFs();
  const dir = taskGatesDir(pm, taskId);
  fs.mkdirSync(dir);
  fs.writeTextSync(join(dir, filename), content);
}

export function deleteGateScript(pm: PathManagerAPI, taskId: string, filename: string): void {
  ensureSafeGateFilename(filename);
  const fs = getSandboxFs();
  const path = join(taskGatesDir(pm, taskId), filename);
  if (fs.existsSync(path)) fs.unlinkSync(path);
}

// ── Per-task in-process mutex queue ──────────────────────────────────────────
// All capability code (tools / plugins) runs in the same Instance Worker process,
// so an in-process queue keyed by taskId is sufficient. No on-disk lock file needed.

const taskQueues = new Map<string, Promise<unknown>>();

export async function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskQueues.get(taskId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  taskQueues.set(taskId, next.catch(() => undefined));
  return next;
}
