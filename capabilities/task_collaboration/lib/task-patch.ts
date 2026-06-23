// @desc Field whitelist validator for task.json updates via update_task.

import type { Stage, TaskFile } from "./task-types.js";

/**
 * Fields that may be modified by update_task.
 *
 * `stages` is included: issuer can edit any stage's content (description, refs,
 * completion_criteria) at any time. The execution cursor (state.current_stage,
 * state.stage_status) lives in state.json and is NOT touched by patch — so
 * editing past or future stages never scrambles in-flight execution.
 */
export const MUTABLE_TASK_FIELDS = [
  "title",
  "description",
  "notify",
  "gates",
  "stages",
  "priority",
  "refs",
  "extensions",
] as const;

export type MutableTaskField = typeof MUTABLE_TASK_FIELDS[number];

const FORBIDDEN_TASK_FIELDS = ["id", "issuer"] as const;

export interface ApplyPatchOk {
  ok: true;
  result: TaskFile;
  fields_changed: MutableTaskField[];
}
export interface ApplyPatchErr {
  ok: false;
  error: string;
}
export type ApplyPatchResult = ApplyPatchOk | ApplyPatchErr;

/** Apply a partial patch onto an existing TaskFile, rejecting forbidden fields. */
export function applyTaskPatch(current: TaskFile, patch: Partial<TaskFile>): ApplyPatchResult {
  const forbidden: string[] = [];
  const next: TaskFile = { ...current };
  const changed: MutableTaskField[] = [];

  for (const key of Object.keys(patch)) {
    if ((FORBIDDEN_TASK_FIELDS as readonly string[]).includes(key)) {
      forbidden.push(key);
      continue;
    }
    if (!(MUTABLE_TASK_FIELDS as readonly string[]).includes(key)) {
      forbidden.push(key);
      continue;
    }
    const f = key as MutableTaskField;
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    (next as unknown as Record<string, unknown>)[f] = value;
    changed.push(f);
  }

  if (forbidden.length > 0) {
    return {
      ok: false,
      error:
        `Forbidden / unknown task fields: ${forbidden.join(", ")}. ` +
        `Mutable: [${MUTABLE_TASK_FIELDS.join(", ")}]; immutable: [${FORBIDDEN_TASK_FIELDS.join(", ")}].`,
    };
  }

  // Field-level validation
  if (patch.notify !== undefined) {
    const cd = (patch.notify as unknown as { children_depth?: unknown }).children_depth;
    if (typeof cd !== "number" || cd < 0 || !Number.isInteger(cd)) {
      return { ok: false, error: "notify.children_depth must be a non-negative integer (required, no default)" };
    }
  }
  if (patch.stages !== undefined) {
    const stagesError = validateStages(patch.stages);
    if (stagesError) return { ok: false, error: stagesError };
  }

  return { ok: true, result: next, fields_changed: changed };
}

function validateStages(stages: unknown): string | null {
  if (!Array.isArray(stages)) return "stages must be an array";
  if (stages.length === 0) return "stages cannot be empty — a task without stages is meaningless; include at least one";
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i] as Partial<Stage> | undefined;
    if (!s || typeof s !== "object") return `stages[${i}] must be an object`;
    if (typeof s.name !== "string" || s.name.length === 0) return `stages[${i}].name is required (non-empty string)`;
    if (typeof s.description !== "string") return `stages[${i}].description is required (string)`;
    if (s.refs !== undefined && !Array.isArray(s.refs)) return `stages[${i}].refs must be an array`;
    if (s.completion_criteria !== undefined && typeof s.completion_criteria !== "string") {
      return `stages[${i}].completion_criteria must be a string`;
    }
  }
  return null;
}

/** Validate a fresh task.json passed to publish_task (independent of patch flow). */
export function validateNewTaskFile(task: TaskFile): string | null {
  if (!task.id) return "id is required";
  if (!task.title) return "title is required";
  if (typeof task.description !== "string") return "description must be a string";
  if (!task.issuer) return "issuer is required";
  if (!task.notify) return "notify is required";
  const cd = task.notify.children_depth;
  if (typeof cd !== "number" || cd < 0 || !Number.isInteger(cd)) {
    return "notify.children_depth must be a non-negative integer (required, no default)";
  }
  const stagesError = validateStages(task.stages);
  if (stagesError) return stagesError;
  return null;
}
