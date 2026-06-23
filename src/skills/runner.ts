/**
 * Phase D4 — SkillRunner.
 *
 * Three entry kinds (per packages/types/src/skill.ts):
 *
 *   prompt → load `.md` from disk, return `{ kind:'prompt', text }`. The
 *            caller (chat composer or context-window injector) is what
 *            actually feeds the text into an LLM turn — the runner just
 *            materializes the file. No execution, no permissions.
 *
 *   ts     → dynamic-import the file, look up `export` (default if omitted),
 *            invoke as `async (ctx) => unknown`. ctx exposes a permission-
 *            scoped subset of the host SDK (callTool + getEventBus + a
 *            scoped fs helper). Tool calls inside a skill are gated by
 *            `requiresTools[]` declared in the manifest.
 *
 *   py     → not supported in this PR — returns code:'py_unsupported'. The
 *            roadmap parks py inside a separate worker package.
 *
 * Runner emits `skill.starting` / `skill.completed` / `skill.failed` on the
 * event bus. Tool calls inside the skill auto-emit `tool.*` via ToolRegistry.
 *
 * The SSE endpoint streams these envelopes verbatim so a UI client can show
 * progress without polling.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SkillDefinition } from '@forgeax/types';
import { getPluginSnapshot } from '../plugins/registry';
import type { SkillEntry } from '../plugins/kinds/types';
import { callTool } from '../tools/registry';
import { getEventBus } from '../events/bus';
import { compilePermissions } from '../permissions/engine';
import { isPaused } from '../runtime/pause';

export interface SkillRunRequest {
  skillId: string;
  /** Optional plugin id to disambiguate when multiple plugins ship the same skill id. */
  pluginId?: string;
  input?: unknown;
  caller: {
    kind: 'user' | 'ai' | 'cli' | 'workbench' | 'event';
    sessionId?: string;
    threadId?: string;
    agentId?: string;
  };
}

export type SkillRunResult =
  | { ok: true; kind: 'prompt'; text: string; durationMs: number }
  | { ok: true; kind: 'ts'; result: unknown; durationMs: number }
  | { ok: false; error: string; code: SkillErrorCode };

type SkillErrorCode =
  | 'not_found'
  | 'load_error'
  | 'invoke_error'
  | 'py_unsupported'
  | 'no_export'
  | 'input_invalid'
  | 'output_invalid'
  | 'timeout'
  | 'paused';

const DEFAULT_SKILL_TIMEOUT_MS = 60_000;

/**
 * 04 §io — minimal JSONSchema validator. We deliberately do not ship ajv
 * here: the supported subset is the slice skill manifests need today
 * (`type`, `required`, `properties`, `enum`). Anything beyond that is
 * passed through as-is. Authors who need the full draft-07 surface can
 * still hand-roll an in-skill check; the runner just guarantees that
 * obviously wrong input/output is caught at the boundary.
 */
type MiniSchema =
  | { type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object'; enum?: unknown[]; required?: string[]; properties?: Record<string, MiniSchema>; items?: MiniSchema }
  | { enum: unknown[] }
  | Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validateAgainst(schema: unknown, value: unknown, path = '$'): string | null {
  if (!schema || typeof schema !== 'object') return null; // permissive
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) {
    if (!s.enum.some((e) => Object.is(e, value) || JSON.stringify(e) === JSON.stringify(value))) {
      return `${path}: value not in enum`;
    }
  }
  const t = s.type as string | undefined;
  if (t) {
    const got = typeOf(value);
    const ok = t === 'integer' ? got === 'number' && Number.isInteger(value as number) : got === t;
    if (!ok) return `${path}: expected ${t}, got ${got}`;
  }
  if (t === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const k of s.required as string[]) {
        if (!(k in v)) return `${path}.${k}: required`;
      }
    }
    if (s.properties && typeof s.properties === 'object') {
      for (const [k, sub] of Object.entries(s.properties as Record<string, unknown>)) {
        if (k in v) {
          const e = validateAgainst(sub, v[k], `${path}.${k}`);
          if (e) return e;
        }
      }
    }
  }
  if (t === 'array' && Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i += 1) {
      const e = validateAgainst(s.items, value[i], `${path}[${i}]`);
      if (e) return e;
    }
  }
  return null;
}

export interface SkillRunCtx {
  caller: SkillRunRequest['caller'];
  input: unknown;
  callTool: typeof callTool;
  /** Reads a file relative to the plugin's originDir. Permission gate is
   *  declared at the manifest layer; this PR does not enforce path scoping
   *  yet — that lands with D6's trust panel. */
  readPluginFile(relPath: string): string;
}

function resolveSkill(req: SkillRunRequest): SkillEntry | null {
  const skills = getPluginSnapshot().kinds.skills;
  if (req.pluginId) {
    return skills.find((s) => s.pluginId === req.pluginId && s.definition.id === req.skillId) ?? null;
  }
  return skills.find((s) => s.definition.id === req.skillId) ?? null;
}

function entryAbsPath(originDir: string, file: string): string {
  return isAbsolute(file) ? file : resolve(originDir, file);
}

/** Doc 14 §4 spike — pre-import static lint of a ts skill source.
 *
 *  In-process dynamic-import means a malicious skill could pull in `fs` or
 *  `child_process` and bypass every runtime gate. Until skills run inside an
 *  isolated worker (parked in [[14-resolutions]] until module-isolation
 *  exists in Bun), we make the skill author opt in: declaring `permissions:
 *  [{ kind:'fs', ... }]` unlocks `fs`/`fs/promises`; `{ kind:'spawn', ... }`
 *  unlocks `child_process`. `vm` and `worker_threads` are flat-deny — no
 *  legitimate skill needs them today, and both are common sandbox-escape
 *  primitives.
 *
 *  The lint is regex-based on purpose: it's a defense-in-depth speed bump,
 *  not a proof. A worker boundary is the real fix; this catches the obvious
 *  foot-guns and forces declared intent for the rest. Returns null when the
 *  source is allowed, or a string reason when it must be rejected. */
function lintSkillSource(
  file: string,
  permissions: Array<{ kind: string }>,
): string | null {
  let src: string;
  try {
    src = readFileSync(file, 'utf-8');
  } catch {
    // Let the actual import below surface the load error with full context.
    return null;
  }
  const hasFs = permissions.some((p) => p.kind === 'fs');
  const hasSpawn = permissions.some((p) => p.kind === 'spawn');

  // Specifier patterns: import|require, default|named|namespace, with or
  // without the `node:` prefix. Match modules that gate runtime escape.
  type Rule = { module: string; allowedBy: 'fs' | 'spawn' | null };
  const rules: Rule[] = [
    { module: 'fs', allowedBy: 'fs' },
    { module: 'fs/promises', allowedBy: 'fs' },
    { module: 'child_process', allowedBy: 'spawn' },
    { module: 'vm', allowedBy: null },
    { module: 'worker_threads', allowedBy: null },
  ];

  for (const r of rules) {
    // Escape `/` for inclusion in a character class.
    const escaped = r.module.replace(/\//g, '\\/');
    // Match any of: `from '...'`, `import '...'`, `import('...')`, `require('...')`,
    // with or without `node:` prefix and either quote style.
    const re = new RegExp(
      `(?:from|import|require)\\s*\\(?\\s*['"](?:node:)?${escaped}['"]`,
    );
    if (!re.test(src)) continue;
    if (r.allowedBy === null) {
      return `skill ${file}: import of "${r.module}" is forbidden (no permission scope unlocks it)`;
    }
    const declared = r.allowedBy === 'fs' ? hasFs : hasSpawn;
    if (!declared) {
      return `skill ${file}: import of "${r.module}" requires permissions:[{kind:'${r.allowedBy}', ...}] declaration`;
    }
  }
  return null;
}

export async function runSkill(req: SkillRunRequest): Promise<SkillRunResult> {
  const bus = getEventBus();
  const threadId = req.caller.threadId;
  // Doc 07 §TopBar Pause — block AI-initiated skills when paused. The
  // runtime emits skill.failed with code:'paused' so the UI can surface
  // the same red dot as a forbidden tool call.
  if (req.caller.kind === 'ai' && isPaused()) {
    const r: SkillRunResult = {
      ok: false,
      error: `skill ${req.skillId} blocked: AI runtime is paused`,
      code: 'paused',
    };
    bus.emit('skill.failed', { skillId: req.skillId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  const entry = resolveSkill(req);
  if (!entry) {
    const r: SkillRunResult = { ok: false, error: `skill not found: ${req.skillId}`, code: 'not_found' };
    bus.emit('skill.failed', { skillId: req.skillId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }

  const def: SkillDefinition = entry.definition;
  bus.emit(
    'skill.starting',
    { skillId: def.id, pluginId: entry.pluginId, kind: def.entry.kind, caller: req.caller },
    { threadId },
  );
  const startedAt = Date.now();

  if (def.entry.kind === 'py') {
    const r: SkillRunResult = {
      ok: false,
      error: 'python skill entry not supported in this build',
      code: 'py_unsupported',
    };
    bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
    return r;
  }

  if (def.entry.kind === 'prompt') {
    const path = entryAbsPath(entry.originDir, def.entry.file);
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch (e) {
      const r: SkillRunResult = {
        ok: false,
        error: `failed to read prompt file ${path}: ${(e as Error).message}`,
        code: 'load_error',
      };
      bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
      return r;
    }
    const durationMs = Date.now() - startedAt;
    bus.emit('skill.completed', { skillId: def.id, durationMs, caller: req.caller }, { threadId });
    return { ok: true, kind: 'prompt', text, durationMs };
  }

  // ts entry — input schema gate.
  if (def.io?.input) {
    const err = validateAgainst(def.io.input, req.input, '$.input');
    if (err) {
      const r: SkillRunResult = { ok: false, error: err, code: 'input_invalid' };
      bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
      return r;
    }
  }

  // ts entry — static-import lint. Doc 14 §4 spike: until the worker-isolated
  // runtime ships, refuse to load a skill.mjs that statically imports a
  // dangerous Node builtin without a matching manifest permission. Catches
  // the obvious foot-guns (fs / child_process / vm / worker_threads) at the
  // entry boundary and is independent of in-process module isolation.
  const file = entryAbsPath(entry.originDir, def.entry.file);
  const declaredPerms = def.permissions ?? [];
  const lintError = lintSkillSource(file, declaredPerms);
  if (lintError) {
    const r: SkillRunResult = { ok: false, error: lintError, code: 'load_error' };
    bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(file)) as Record<string, unknown>;
  } catch (e) {
    const r: SkillRunResult = {
      ok: false,
      error: `failed to import ${file}: ${(e as Error).message}`,
      code: 'load_error',
    };
    bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  const exportName = def.entry.export ?? 'default';
  const fn = mod[exportName];
  if (typeof fn !== 'function') {
    const r: SkillRunResult = {
      ok: false,
      error: `module ${file} has no callable export "${exportName}"`,
      code: 'no_export',
    };
    bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
    return r;
  }

  // P7 — runtime PermissionEngine. Compile both `requiresTools[]` (legacy)
  // and `permissions[]` into a single matcher; default-deny when both are
  // empty for the capability in question.
  const allowedTools = new Set(def.requiresTools ?? []);
  const matcher = compilePermissions(def.permissions ?? []);
  const scopedCallTool: typeof callTool = async (toolReq) => {
    const inRequires = allowedTools.size === 0 || allowedTools.has(toolReq.toolId);
    if (!inRequires) {
      return {
        ok: false,
        error: `skill ${def.id} did not declare requiresTools["${toolReq.toolId}"]`,
        code: 'forbidden',
      };
    }
    // If skill declared structured tool-permissions, gate on those too.
    const hasToolPerms = matcher.source.some((p) => p.kind === 'tool');
    if (hasToolPerms) {
      const verdict = matcher.canTool(toolReq.toolId);
      if (!verdict.ok) return { ok: false, error: verdict.reason ?? 'forbidden', code: 'forbidden' };
    }
    return callTool(toolReq);
  };

  const hasFsPerms = matcher.source.some((p) => p.kind === 'fs');
  const ctx: SkillRunCtx = {
    caller: req.caller,
    input: req.input,
    callTool: scopedCallTool,
    readPluginFile(relPath) {
      const abs = entryAbsPath(entry.originDir, relPath);
      if (hasFsPerms) {
        const v = matcher.canFs({ mode: 'read', path: abs });
        if (!v.ok) {
          throw Object.assign(new Error(v.reason ?? 'forbidden'), { code: 'forbidden' });
        }
      }
      return readFileSync(abs, 'utf-8');
    },
  };

  const timeoutMs = def.timeoutMs ?? DEFAULT_SKILL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ __timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });
  try {
    const handlerPromise = Promise.resolve().then(() =>
      (fn as (c: SkillRunCtx) => unknown | Promise<unknown>)(ctx),
    );
    const winner = await Promise.race([handlerPromise.then((r) => ({ __ok: r })), timeoutPromise]);
    if ('__timeout' in winner) {
      const r: SkillRunResult = {
        ok: false,
        error: `skill ${def.id} exceeded timeout of ${timeoutMs}ms`,
        code: 'timeout',
      };
      bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
      return r;
    }
    if (timer) clearTimeout(timer);
    const result = winner.__ok;
    if (def.io?.output) {
      const err = validateAgainst(def.io.output, result, '$.output');
      if (err) {
        const r: SkillRunResult = { ok: false, error: err, code: 'output_invalid' };
        bus.emit('skill.failed', { skillId: def.id, error: r.error, caller: req.caller }, { threadId });
        return r;
      }
    }
    const durationMs = Date.now() - startedAt;
    bus.emit('skill.completed', { skillId: def.id, durationMs, caller: req.caller }, { threadId });
    return { ok: true, kind: 'ts', result, durationMs };
  } catch (e) {
    if (timer) clearTimeout(timer);
    const err = (e as Error).message ?? String(e);
    bus.emit('skill.failed', { skillId: def.id, error: err, caller: req.caller }, { threadId });
    return { ok: false, error: err, code: 'invoke_error' };
  }
}

/** Public listing — surfaces skill catalog with display metadata. */
export interface SkillDescriptor {
  id: string;
  pluginId: string;
  kind: SkillDefinition['entry']['kind'];
  triggers: SkillDefinition['triggers'];
  requiresTools: string[];
  displayName: SkillDefinition['displayName'];
  description: SkillDefinition['description'];
}

export function listSkills(): SkillDescriptor[] {
  return getPluginSnapshot().kinds.skills.map((s) => ({
    id: s.definition.id,
    pluginId: s.pluginId,
    kind: s.definition.entry.kind,
    triggers: s.definition.triggers,
    requiresTools: s.definition.requiresTools ?? [],
    displayName: s.definition.displayName,
    description: s.definition.description,
  }));
}
