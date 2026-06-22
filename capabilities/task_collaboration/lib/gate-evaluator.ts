// @desc Recursively evaluate Gate trees → GateProgress. 5s per-script timeout, captures stdout first line.

import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { PathManagerAPI } from "#src/core/types.js";
import { getTerminalManager } from "#src/terminal/manager.js";
import { resolveScriptPath } from "./gate-resolver.js";
import type { Gate, GateLeaf, GateProgress, GateProgressLeaf } from "./task-types.js";

const DEFAULT_TIMEOUT_MS = 5000;

export interface EvalContext {
  pm: PathManagerAPI;
  taskId: string;
  /** Override per-script timeout in ms (default 5000). */
  timeoutMs?: number;
}

/** Recursively evaluate the gate tree, mirroring its shape into a GateProgress. */
export function evaluateGate(gate: Gate, ctx: EvalContext): GateProgress {
  if (isLeaf(gate)) return evaluateLeaf(gate, ctx);
  if ("all" in gate) {
    const children = gate.all.map(g => evaluateGate(g, ctx));
    return { kind: "all", pass: children.every(c => c.pass), children };
  }
  if ("any" in gate) {
    const children = gate.any.map(g => evaluateGate(g, ctx));
    return { kind: "any", pass: children.some(c => c.pass), children };
  }
  const child = evaluateGate(gate.not, ctx);
  return { kind: "not", pass: !child.pass, child };
}

function isLeaf(gate: Gate): gate is GateLeaf {
  return typeof (gate as GateLeaf).script === "string";
}

function evaluateLeaf(leaf: GateLeaf, ctx: EvalContext): GateProgressLeaf {
  let resolved;
  try {
    resolved = resolveScriptPath(ctx.pm, ctx.taskId, leaf.script);
  } catch (err) {
    return {
      kind: "leaf",
      script: leaf.script,
      pass: false,
      stdout: "",
      reason: `path error: ${(err as Error).message}`,
    };
  }
  if (!getSandboxFs().existsSync(resolved.absPath)) {
    return {
      kind: "leaf",
      script: leaf.script,
      pass: false,
      stdout: "",
      reason: `script not found: ${resolved.absPath}`,
    };
  }

  const cwd = ctx.pm.team().sharedWorkspace();
  const env: Record<string, string> = {
    TASK_ID: ctx.taskId,
    TASK_DIR: `tasks/${ctx.taskId}`,
  };
  const timeout = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Wrapper: ensure execSync never throws on script-level non-zero exits;
  // append "::TASK_EXIT=<code>" so the evaluator can recover the real exit code.
  const wrapper = 'set +e; bash "$0" "$@" 2>&1; printf "::TASK_EXIT=%d\\n" $?; exit 0';
  const args = leaf.args ?? [];

  let raw: string;
  try {
    raw = getTerminalManager().execSync(
      "bash",
      ["-c", wrapper, resolved.absPath, ...args],
      { cwd, env, timeout },
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const isTimeout = /code null|etimedout/i.test(msg);
    return {
      kind: "leaf",
      script: leaf.script,
      pass: false,
      stdout: "",
      reason: isTimeout ? `timeout (${timeout}ms)` : `exec error: ${msg.slice(0, 200)}`,
    };
  }

  const lines = raw.split("\n");
  let exitCode: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^::TASK_EXIT=(\d+)$/);
    if (m) {
      exitCode = parseInt(m[1], 10);
      lines.splice(i, 1);
      break;
    }
  }

  const cleaned = lines.join("\n").trim();
  const firstLine = cleaned.split("\n")[0]?.trim() ?? "";

  if (exitCode === null) {
    return {
      kind: "leaf",
      script: leaf.script,
      pass: false,
      stdout: firstLine,
      reason: "no exit code captured (script may have been killed)",
    };
  }
  if (exitCode === 0) {
    return { kind: "leaf", script: leaf.script, pass: true, stdout: firstLine };
  }
  return {
    kind: "leaf",
    script: leaf.script,
    pass: false,
    stdout: firstLine,
    reason: `exit ${exitCode}`,
  };
}

/** Render GateProgress as a human-readable tree (used by board-tasks slot). */
export function renderGateProgress(gp: GateProgress, indent = ""): string {
  const mark = gp.pass ? "✓" : "✗";
  if (gp.kind === "leaf") {
    const status = gp.stdout ? `: ${gp.stdout}` : "";
    const reason = gp.reason && !gp.pass ? ` (${gp.reason})` : "";
    return `${indent}${mark} ${gp.script}${status}${reason}`;
  }
  if (gp.kind === "not") {
    return `${indent}${mark} not:\n${renderGateProgress(gp.child, indent + "    ")}`;
  }
  // all / any
  const lines = [`${indent}${mark} ${gp.kind} of:`];
  for (const c of gp.children) lines.push(renderGateProgress(c, indent + "    "));
  return lines.join("\n");
}
