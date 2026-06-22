// @desc Plan file operations — scan, rename, read, parse plan files by status extension
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { join } from "node:path";

export type PlanStatus = "plan" | "done" | "failed";

export interface PlanFileEntry {
  name: string;
  status: PlanStatus;
  path: string;
}

const PLAN_RE = /^(.+)\.(plan|done|failed)\.md$/;

export function plansDir(homeDir: string): string {
  return join(homeDir, "plans");
}

export function planFilePath(homeDir: string, name: string, status: PlanStatus): string {
  return join(homeDir, "plans", `${name}.${status}.md`);
}

/** Synchronous scan — safe for condition functions. */
export function scanPlansSync(homeDir: string): PlanFileEntry[] {
  const fs = getSandboxFs();
  try {
    return fs.readdirSync(plansDir(homeDir))
      .map((f) => {
        const m = f.match(PLAN_RE);
        return m ? { name: m[1], status: m[2] as PlanStatus, path: join(homeDir, "plans", f) } : null;
      })
      .filter(Boolean) as PlanFileEntry[];
  } catch {
    return [];
  }
}

/** Async scan. */
export async function scanPlans(homeDir: string): Promise<PlanFileEntry[]> {
  const fs = getSandboxFs();
  try {
    const dir = plansDir(homeDir);
    const entries = fs.readdirSync(dir);
    return entries
      .map((f) => {
        const m = f.match(PLAN_RE);
        return m ? { name: m[1], status: m[2] as PlanStatus, path: join(dir, f) } : null;
      })
      .filter(Boolean) as PlanFileEntry[];
  } catch {
    return [];
  }
}

export function findPendingPlans(homeDir: string): PlanFileEntry[] {
  return scanPlansSync(homeDir).filter((p) => p.status === "plan");
}

export async function renamePlanStatus(
  homeDir: string,
  name: string,
  from: PlanStatus,
  to: PlanStatus,
): Promise<void> {
  getSandboxFs().renameSync(planFilePath(homeDir, name, from), planFilePath(homeDir, name, to));
}

/** Read a plan file synchronously. Returns content or empty string. */
export function readPlanFileSync(entry: PlanFileEntry): string {
  try {
    return getSandboxFs().readTextSync(entry.path);
  } catch {
    return "";
  }
}

export interface ParsedTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

/**
 * Parse todos from plan markdown.
 * Matches lines like: `- [ ] **t1**: description` or `- [x] **t2**: done task`
 */
export function parseTodosFromMarkdown(md: string): ParsedTodo[] {
  const todos: ParsedTodo[] = [];
  const re = /^- \[([x ])\] \*\*(\S+?)\*\*:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    todos.push({
      id: m[2],
      content: m[3].trim(),
      status: m[1] === "x" ? "completed" : "pending",
    });
  }
  return todos;
}
