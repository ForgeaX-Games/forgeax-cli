// @desc Create a new task folder under shared-workspace/tasks/{id}/ with task.json + state.json + optional gates files.

import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  taskExists,
  ensureTaskDir,
  writeTaskFile,
  writeTaskState,
  writeGateScript,
  ensureSafeGateFilename,
} from "../lib/task-dir.js";
import { appendTaskLog } from "../lib/task-log.js";
import { validateNewTaskFile } from "../lib/task-patch.js";
import {
  makeInitialState,
  type TaskFile,
  type Gate,
  type TaskNotify,
  type Stage,
} from "../lib/task-types.js";
import { notifyPublish } from "../lib/push-notifier.js";

function generateTaskId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  const ts = Date.now().toString(36);
  return slug ? `${slug}_${ts}` : `task_${ts}`;
}

export default {
  name: "publish_task",
  description:
    "Publish a new task to the shared task board (creates `tasks/{id}/` with task.json + state.json + optional gate scripts). " +
    "Stages array is REQUIRED and must be non-empty — a task is a multi-step collaboration; if you only have one bullet, you don't need a task.",
  guidance:
    "stages: REQUIRED non-empty array. Each stage = a self-contained sub-step with its own description / refs / completion_criteria. Issuer can edit stage content later via update_task; the execution cursor (state.current_stage) is independent and unaffected by edits. " +
    "notify.children_depth is REQUIRED — declare your broadcast scope explicitly (0 = no children; N = BFS N levels). " +
    "notify acts as both broadcast scope AND join eligibility — any agent resolved by notify (children_depth BFS / agentIds / groupIds) can join_task. minParty/maxParty are NOT supported — express via gates with lib/gates/participant_count.sh. " +
    "gates is an optional JSON tree: { script,args? } | { all:[] } | { any:[] } | { not:... }. Empty gates → task is ready immediately on join. " +
    "Refs containing `@task:closed_id` are auto-expanded into the publish push body.",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Optional task ID; auto-generated from title + timestamp when omitted. Must match [a-zA-Z0-9_-]{1,64}.",
      },
      title: { type: "string" },
      description: { type: "string" },
      notify: {
        type: "object",
        description: "Broadcast circle for publish/close/cancel pushes. children_depth is REQUIRED.",
        properties: {
          children_depth: {
            type: "number",
            description: "REQUIRED. 0 = no broadcast to children; N = BFS expansion of N levels of subtree.",
          },
          agentIds: { type: "array", items: { type: "string" } },
          groupIds: { type: "array", items: { type: "string" } },
          channels: { type: "array", items: { type: "string" } },
        },
        required: ["children_depth"],
      },
      stages: {
        type: "array",
        description: "REQUIRED non-empty array. Each stage = a self-contained sub-step (name + description + optional refs + optional completion_criteria). Participant works through stages one at a time; issuer advances after each completion.",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short display name (e.g. '调研')" },
            description: { type: "string", description: "What this stage is asking the participant to do." },
            refs: { type: "array", items: { type: "string" }, description: "Files / @task: refs scoped to this stage." },
            completion_criteria: { type: "string", description: "Free-text guidance the issuer uses to judge completion." },
          },
          required: ["name", "description"],
        },
      },
      gates: {
        type: "object",
        description: "Optional gate logic tree controlling claiming → ready transition.",
      },
      gates_files: {
        type: "object",
        description: "Optional task-local gate scripts (filename → content). Filenames must end with .sh.",
        additionalProperties: { type: "string" },
      },
      priority: { type: "number" },
      refs: {
        type: "array",
        items: { type: "string" },
        description: "Refs (file paths or `@task:<id>` references). Closed task refs auto-expand into publish push.",
      },
      extensions: { type: "object", additionalProperties: true },
    },
    required: ["title", "description", "notify", "stages"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const title = String(args.title ?? "").trim();
    if (!title) return "Error: title is required";
    const description = String(args.description ?? "").trim();
    const notify = args.notify as TaskNotify | undefined;
    if (!notify) return "Error: notify is required";
    const gates = args.gates as Gate | undefined;
    const gates_files = args.gates_files as Record<string, string> | undefined;
    const stages = args.stages as Stage[] | undefined;
    if (!stages || !Array.isArray(stages) || stages.length === 0) {
      return "Error: stages is required and must be a non-empty array — a single-step task is meaningless";
    }

    const taskId = (args.id != null ? String(args.id).trim() : "") || generateTaskId(title);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) {
      return `Error: invalid task ID '${taskId}' (must match [a-zA-Z0-9_-]{1,64})`;
    }
    if (taskExists(ctx.pathManager, taskId)) {
      return `Error: task '${taskId}' already exists at tasks/${taskId}/`;
    }

    const task: TaskFile = {
      id: taskId,
      title,
      description,
      issuer: ctx.agentId,
      notify,
      stages,
      ...(gates !== undefined ? { gates } : {}),
      ...(args.priority !== undefined ? { priority: Number(args.priority) } : {}),
      ...(Array.isArray(args.refs) ? { refs: (args.refs as unknown[]).map(String) } : {}),
      ...(args.extensions !== undefined ? { extensions: args.extensions as Record<string, unknown> } : {}),
    };

    const validateError = validateNewTaskFile(task);
    if (validateError) return `Error: ${validateError}`;

    if (gates_files) {
      for (const filename of Object.keys(gates_files)) {
        try {
          ensureSafeGateFilename(filename);
        } catch (err) {
          return `Error: ${(err as Error).message}`;
        }
      }
    }

    ensureTaskDir(ctx.pathManager, taskId);
    writeTaskFile(ctx.pathManager, taskId, task);
    const initialState = makeInitialState();
    writeTaskState(ctx.pathManager, taskId, initialState);

    if (gates_files) {
      for (const [filename, content] of Object.entries(gates_files)) {
        writeGateScript(ctx.pathManager, taskId, filename, String(content));
      }
    }

    appendTaskLog(ctx.pathManager, taskId, {
      type: "state_change",
      from: "draft",
      to: "posted",
      actor: ctx.agentId,
      reason: "publish_task",
    });

    notifyPublish(ctx, task);

    return `Published task '${taskId}' (${title}). Status: posted. ${stages.length} stage(s): [${stages.map(s => s.name).join(" → ")}]. Real agents in notify scope have been notified.`;
  },
  serial: true,
} satisfies ToolDefinition;
