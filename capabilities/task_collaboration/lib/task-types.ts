// @desc Type definitions for the universal task orchestrator (TaskFile + Stage[] / TaskState / Gate / log).

/**
 * Task lifecycle status.
 *
 * Three PARALLEL TERMINAL statuses (no "completed → closed" chain, no transitions out):
 *   - completed : all stages approved by issuer (success archive)
 *   - closed    : issuer-driven archive without success — abandoned, superseded, no-longer-needed
 *   - failed    : task ended in failure (irrecoverable error / participant could not deliver)
 *
 * Non-terminal statuses (draft / posted / claiming / ready / active / blocked) can transition
 * into any of the three terminals via update_task; terminal tasks are filtered from live slots
 * (board-tasks / board-view) and never re-surface.
 */
export type TaskBoardStatus =
  | "draft"
  | "posted"
  | "claiming"
  | "ready"
  | "active"
  | "blocked"
  | "completed"
  | "closed"
  | "failed";

export const TASK_TERMINAL_STATUSES: ReadonlySet<TaskBoardStatus> =
  new Set<TaskBoardStatus>(["completed", "closed", "failed"]);

/** Per-stage internal state (only meaningful when task.status === "active"). */
export type StageStatus = "pending" | "active" | "completed";

/**
 * One stage of a task — equivalent in granularity to a small task: has its own
 * description, optional refs, optional completion criteria. Issuer writes the
 * full sequence at publish time; can edit later via update_task (the fixed
 * `state.current_stage` index protects in-flight execution from being
 * scrambled by edits to past stages).
 */
export interface Stage {
  /** Short display name, e.g. "调研", "整合", "沉淀". */
  name: string;
  /** What this stage is asking the participant to do. */
  description: string;
  /** Files / `@task:closed_id` refs scoped to this stage. */
  refs?: string[];
  /** Free-text guidance for the issuer when reviewing completion. */
  completion_criteria?: string;
}

/** Static task definition (task.json). Mutable subset via update_task; id/issuer immutable. */
export interface TaskFile {
  /** Stable identifier — IMMUTABLE after publish. */
  id: string;
  /** Overall task title (what's the big picture). */
  title: string;
  /** Top-level overview / context. Stage-specific details live in `stages[*].description`. */
  description: string;
  /** Task issuer agent ID — IMMUTABLE after publish. Only the issuer can update / cancel / close. */
  issuer: string;

  notify: TaskNotify;
  gates?: Gate;

  /**
   * REQUIRED. The full stage sequence is written at publish time. A task is a
   * multi-step collaboration — single-step "tasks" should not exist; if you
   * have only one bullet, you don't need a task. Issuer may edit any stage's
   * content via update_task at any time; `state.current_stage` is independent
   * and unaffected by such edits.
   */
  stages: Stage[];

  priority?: number;
  /** Task-wide refs (apply to the whole task, not a specific stage). */
  refs?: string[];
  extensions?: Record<string, unknown>;
}

/** Audience field used at publish + close + cancel boundaries (life/death broadcast). */
export interface TaskNotify {
  /** REQUIRED, no default. 0 = no broadcast to children; N = BFS expansion of N levels of subtree. */
  children_depth: number;
  agentIds?: string[];
  groupIds?: string[];
  channels?: string[];
}

/** Gate logic tree. JSON DSL: leaf | all | any | not. */
export type Gate =
  | GateLeaf
  | { all: Gate[] }
  | { any: Gate[] }
  | { not: Gate };

export interface GateLeaf {
  /**
   * Path resolved with task.json's containing folder as origin.
   *  - `lib/gates/xxx.sh` → routed to `capabilities/task_collaboration/lib/gates/xxx.sh`
   *  - `gates/xxx.sh`     → resolved to `tasks/{id}/gates/xxx.sh`
   *  - other relative     → resolved against `tasks/{id}/`
   */
  script: string;
  args?: string[];
}

/**
 * Mutable runtime state (state.json). Frequent writes; protected by per-task mutex.
 *
 * Crucially: `current_stage` and `stage_status` are the **execution cursor**.
 * They only change via explicit stage_action transitions (advance / redo /
 * complete_stage). Editing `task.stages` content via update_task does NOT
 * mutate the cursor — past or future stage edits never scramble in-flight
 * execution.
 */
export interface TaskState {
  status: TaskBoardStatus;
  participants: string[];

  /** 0-based index into `task.stages`. Only meaningful when status === "active". */
  current_stage: number;
  /** Internal state of the current stage. "pending" before active; "active"/"completed" within. */
  stage_status: StageStatus;

  /** Set when transitioning into `blocked`, so unblock can restore the prior status if needed. */
  blockedFromStatus?: TaskBoardStatus;
  gate_progress?: GateProgress;
  /** ISO 8601 — updated on every successful write. */
  updatedAt: string;
}

/** Result snapshot of a single gate evaluation pass. */
export type GateProgress =
  | GateProgressLeaf
  | { kind: "all"; pass: boolean; children: GateProgress[] }
  | { kind: "any"; pass: boolean; children: GateProgress[] }
  | { kind: "not"; pass: boolean; child: GateProgress };

export interface GateProgressLeaf {
  kind: "leaf";
  script: string;
  pass: boolean;
  /** Short progress text — first line of stdout (e.g. "2/3", "closed", "waiting"). */
  stdout?: string;
  /** Reason a leaf failed (timeout / spawn error / non-zero exit). */
  reason?: string;
}

/** Append-only log entries (log.jsonl). */
export type TaskLogEntry =
  | { ts: string; type: "state_change"; from: TaskBoardStatus; to: TaskBoardStatus; actor: string; reason?: string }
  | { ts: string; type: "join"; agentId: string }
  | { ts: string; type: "leave"; agentId: string }
  | { ts: string; type: "update"; actor: string; fields_changed: string[]; reason?: string }
  | { ts: string; type: "gate_pass"; snapshot: GateProgress }
  | { ts: string; type: "stage_complete"; stage_index: number; stage_name: string; agentId: string }
  | { ts: string; type: "stage_advance"; from_stage: number; to_stage: number; actor: string; reason?: string }
  | { ts: string; type: "stage_redo"; stage_index: number; actor: string; reason?: string }
  | { ts: string; type: "message"; from: string; to: string[]; progress?: boolean; content: string };

/** Default initial state for a freshly published task. */
export function makeInitialState(): TaskState {
  return {
    status: "posted",
    participants: [],
    current_stage: 0,
    stage_status: "pending",
    updatedAt: new Date().toISOString(),
  };
}
