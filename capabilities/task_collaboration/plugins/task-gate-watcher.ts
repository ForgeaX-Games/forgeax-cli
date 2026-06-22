// @desc Plugin: poll claiming-status tasks issued by this agent, evaluate gates, advance to ready when satisfied.

import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";
import { listAllTasks } from "../lib/task-board.js";
import {
  taskExists,
  withTaskLock,
  readTaskState,
  writeTaskState,
  readTaskFile,
} from "../lib/task-dir.js";
import { evaluateGate } from "../lib/gate-evaluator.js";
import { appendTaskLog } from "../lib/task-log.js";
import { notifyStateChange } from "../lib/push-notifier.js";

const POLL_INTERVAL_MS = 5000;

export default function create(ctx: AgentContext): PluginSource {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    let summaries;
    try {
      summaries = listAllTasks(ctx.pathManager);
    } catch {
      schedule();
      return;
    }
    for (const s of summaries) {
      if (stopped) return;
      if (s.task.issuer !== ctx.agentId) continue;
      if (s.state.status !== "claiming") continue;
      try {
        await processTask(ctx, s.id);
      } catch {
        // ignore per-task errors; keep polling.
      }
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, POLL_INTERVAL_MS);
  }

  return {
    name: "task_gate_watcher",
    start() {
      stopped = false;
      // Run once shortly after start, then poll on schedule.
      timer = setTimeout(() => { void tick(); }, 200);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

async function processTask(ctx: AgentContext, taskId: string): Promise<void> {
  await withTaskLock(taskId, async () => {
    if (!taskExists(ctx.pathManager, taskId)) return;
    const task = readTaskFile(ctx.pathManager, taskId);
    let state = readTaskState(ctx.pathManager, taskId);
    if (state.status !== "claiming") return;
    if (task.issuer !== ctx.agentId) return;

    // Evaluate gates (or auto-pass if undefined)
    let progress: ReturnType<typeof evaluateGate> | undefined;
    let allPassed = true;
    if (task.gates !== undefined) {
      progress = evaluateGate(task.gates, { pm: ctx.pathManager, taskId });
      allPassed = progress.pass;
    }

    // Always refresh gate_progress so slots reflect latest evaluation.
    const next = { ...state, gate_progress: progress };
    let advanced = false;
    if (allPassed) {
      next.status = "ready";
      advanced = true;
    }
    writeTaskState(ctx.pathManager, taskId, next);
    state = next;

    if (advanced) {
      if (progress) {
        appendTaskLog(ctx.pathManager, taskId, {
          type: "gate_pass",
          snapshot: progress,
        });
      }
      appendTaskLog(ctx.pathManager, taskId, {
        type: "state_change",
        from: "claiming",
        to: "ready",
        actor: `plugin:task_gate_watcher:${ctx.agentId}`,
        reason: progress ? "all gates passed" : "no gates declared",
      });
      notifyStateChange(ctx, task, state, "claiming", "ready", progress ? "gates passed" : "no gates");
    }
  });
}
