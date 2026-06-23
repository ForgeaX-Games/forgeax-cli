// @desc Append-only event log (log.jsonl) for tasks.

import { dirname } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { PathManagerAPI } from "#src/core/types.js";
import { taskLogPath } from "./task-dir.js";
import type { TaskLogEntry } from "./task-types.js";

// Distributive Omit so each union member keeps its own discriminated fields
// (without this, a regular Omit collapses the union to common fields only).
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type LogEntryInput = DistributiveOmit<TaskLogEntry, "ts"> & { ts?: string };

export function appendTaskLog(
  pm: PathManagerAPI,
  taskId: string,
  entry: LogEntryInput,
): void {
  const fs = getSandboxFs();
  const path = taskLogPath(pm, taskId);
  fs.mkdirSync(dirname(path));
  const ts = entry.ts ?? new Date().toISOString();
  const full = { ts, ...entry } as unknown as TaskLogEntry;
  fs.appendTextSync(path, JSON.stringify(full) + "\n");
}

export function readTaskLog(pm: PathManagerAPI, taskId: string): TaskLogEntry[] {
  const fs = getSandboxFs();
  const path = taskLogPath(pm, taskId);
  if (!fs.existsSync(path)) return [];
  return fs.readTextSync(path)
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as TaskLogEntry);
}

/** Read just the last N entries efficiently (full read + slice — task logs are bounded by a single task lifecycle). */
export function readTaskLogTail(pm: PathManagerAPI, taskId: string, n: number): TaskLogEntry[] {
  const all = readTaskLog(pm, taskId);
  return n >= all.length ? all : all.slice(all.length - n);
}
