/**
 * Doc 09 §2.3 — Record-as-skill (deterministic recorder + optional LLM distillation).
 *
 * The deterministic baseline is `recordAsSkill()`: take recorded
 * `tool.starting` envelopes from the bus ledger (or supplied directly)
 * and synthesize a ts skill that re-issues each call in order. Output is
 * a complete L2 plugin directory:
 *
 *   forgeax-plugin.json  — manifest with single `skill` provide
 *   skill.mjs            — esm module that calls ctx.callTool() per step
 *
 * `distillRecordedSkill()` wraps that with an LLM-driven enrichment step:
 * pipe the recorded sequence through `lib/llm-gateway` (or any compatible
 * `complete()` function), parse a small JSON block from the model, and
 * write enriched `description` plus a sidecar `skill.md` containing the
 * prose summary + step narration. The replay logic still runs verbatim —
 * the LLM only authors the human-readable surface.
 *
 * Out of scope for this pass:
 *   - argument templating / parameterization (replays the literal args).
 *     Abstracting recorded-literal → typed-parameter requires a
 *     round-trip schema sniff which deserves its own contract test;
 *     keeping the replay verbatim is the safer first move.
 *   - dependency declaration beyond the dedup of recorded toolIds.
 *
 * The LLM step degrades gracefully: if `complete()` throws or returns
 * malformed JSON, the writer falls back to the deterministic
 * description and skips the sidecar. Failure of the polish step never
 * blocks the loop closing.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RecordedToolCall {
  toolId: string;
  args: unknown;
}

export interface RecordSkillInput {
  /** Project root that owns L2; defaults to cwd. */
  projectRoot: string;
  /** New plugin id, e.g. `@me/replay-foo`. The slug after `/` becomes the dir. */
  pluginId: string;
  /** Skill id inside the plugin, e.g. `s.replay`. */
  skillId: string;
  displayName: { zh: string; en: string };
  description?: { zh: string; en: string };
  /** Ordered tool-calls to replay. Empty array is rejected. */
  recorded: RecordedToolCall[];
  /** Tools the synthesized skill is allowed to call. Defaults to the
   *  unique set extracted from `recorded`. */
  requiresTools?: string[];
  /** Lift recorded literals into typed inputs. When supplied, the synthesized
   *  skill reads `ctx.input.<name>` and substitutes per `appliesTo`; otherwise
   *  it replays the recording verbatim. Validated downstream — bad entries
   *  drop silently and the writer still emits a working skill. */
  parameters?: ProposedParameter[];
}

export type RecordSkillResult =
  | { ok: true; pluginDir: string; manifestPath: string; skillPath: string }
  | { ok: false; code: 'bad_input' | 'exists'; error: string };

function slugFor(pluginId: string): string {
  const slash = pluginId.indexOf('/');
  return slash >= 0 ? pluginId.slice(slash + 1) : pluginId;
}

export function recordAsSkill(input: RecordSkillInput): RecordSkillResult {
  if (!input.pluginId || !input.skillId) {
    return { ok: false, code: 'bad_input', error: 'pluginId + skillId required' };
  }
  if (!Array.isArray(input.recorded) || input.recorded.length === 0) {
    return { ok: false, code: 'bad_input', error: 'recorded[] must be non-empty' };
  }
  for (const r of input.recorded) {
    if (!r || typeof r.toolId !== 'string' || r.toolId.length === 0) {
      return { ok: false, code: 'bad_input', error: 'every recorded entry needs a toolId string' };
    }
  }

  const slug = slugFor(input.pluginId);
  const pluginDir = join(input.projectRoot, '.forgeax', 'plugins', slug);
  if (existsSync(pluginDir)) {
    return { ok: false, code: 'exists', error: `${pluginDir} already exists; pick a new pluginId` };
  }
  mkdirSync(pluginDir, { recursive: true });

  const requires = Array.from(
    new Set(input.requiresTools ?? input.recorded.map((r) => r.toolId)),
  );

  const validParams = validateParameters(input.parameters ?? [], input.recorded);
  const ioInput = validParams.length > 0 ? buildIoInputSchema(validParams) : undefined;

  const skillEntry: Record<string, unknown> = {
    id: input.skillId,
    entry: { kind: 'ts', file: './skill.mjs' },
    requiresTools: requires,
  };
  if (ioInput) skillEntry.io = { input: ioInput };

  const manifest = {
    schemaVersion: 1,
    version: '0.1.0',
    id: input.pluginId,
    kind: 'skill',
    displayName: input.displayName,
    description: input.description ?? {
      zh: '由 record-as-skill 自动生成的回放骨架',
      en: 'Auto-generated replay skeleton from record-as-skill',
    },
    provides: { skills: [skillEntry] },
  };
  const manifestPath = join(pluginDir, 'forgeax-plugin.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  const skillPath = join(pluginDir, 'skill.mjs');
  writeFileSync(skillPath, synthesizeSkillSource(input.recorded, validParams), 'utf-8');

  return { ok: true, pluginDir, manifestPath, skillPath };
}

/** Mini JSONSchema for the skill's `io.input`, enumerating each proposed
 *  parameter's name + type. Defaults are kept in the schema so the runtime
 *  validator + the skill body can both reference them. */
function buildIoInputSchema(params: ProposedParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of params) {
    const prop: Record<string, unknown> = { type: p.schema.type };
    if (p.schema.default !== undefined) prop.default = p.schema.default;
    if (p.schema.description) prop.description = p.schema.description;
    properties[p.name] = prop;
  }
  return { type: 'object', additionalProperties: false, properties };
}

/** Emit a JS skill that:
 *  - Reads `ctx.input` (the SkillRunner-validated input map) for each param
 *  - Substitutes values into the recorded literal args at every (stepIndex,
 *    argPath) target
 *  - Calls each recorded tool in order, bubbling the first failure */
function synthesizeSkillSource(recorded: RecordedToolCall[], params: ProposedParameter[]): string {
  const lines: string[] = [];
  lines.push('// Auto-generated by record-as-skill — replays a recorded sequence.');
  if (params.length > 0) {
    lines.push('// LLM-distilled parameters lift recorded literals into ctx.input fields.');
  } else {
    lines.push('// Edit by hand to parameterize, branch, or distill into prose.');
  }
  lines.push('export default async function (ctx) {');
  lines.push('  const input = (ctx && ctx.input) || {};');

  // Per-parameter coalescer: input.<name> falls back to the recorded literal.
  for (const p of params) {
    const def = p.schema.default !== undefined ? JSON.stringify(p.schema.default) : 'undefined';
    lines.push(
      `  const _p_${p.name} = (input.${p.name} === undefined ? ${def} : input.${p.name});`,
    );
  }

  // Per-step args literal with substitutions applied.
  // Strategy: emit the original args literal, then assign overrides for each
  // (stepIndex, argPath) that points here. Cheap, deterministic, no runtime
  // dep on lodash-set.
  lines.push('  const results = [];');
  for (let i = 0; i < recorded.length; i += 1) {
    const step = recorded[i];
    const argsLit = JSON.stringify(step.args ?? {});
    lines.push(`  // step ${i + 1}: ${step.toolId}`);
    lines.push(`  const a${i} = ${argsLit};`);
    for (const p of params) {
      for (const target of p.appliesTo) {
        if (target.stepIndex !== i) continue;
        const parts = target.argPath.split('.');
        // Build the parent-object access expression and the leaf key.
        if (parts.length === 1) {
          lines.push(`  a${i}[${JSON.stringify(parts[0])}] = _p_${p.name};`);
        } else {
          const parentPath = parts.slice(0, -1).map((s) => `[${JSON.stringify(s)}]`).join('');
          const leaf = parts[parts.length - 1];
          // Navigate-or-create each intermediate object so we don't NPE on
          // a partially-shaped recording.
          for (let depth = 1; depth < parts.length; depth += 1) {
            const partial = parts.slice(0, depth).map((s) => `[${JSON.stringify(s)}]`).join('');
            lines.push(`  if (a${i}${partial} == null) a${i}${partial} = {};`);
          }
          lines.push(`  a${i}${parentPath}[${JSON.stringify(leaf)}] = _p_${p.name};`);
        }
      }
    }
    lines.push(
      `  const r${i} = await ctx.callTool({ toolId: ${JSON.stringify(step.toolId)}, args: a${i}, caller: ctx.caller });`,
    );
    lines.push(`  if (!r${i}.ok) return { ok: false, step: ${i}, error: r${i}.error };`);
    lines.push(`  results.push(r${i}.result);`);
  }
  lines.push('  return { ok: true, results };');
  lines.push('}');
  return lines.join('\n') + '\n';
}

// ─── LLM-distilled variant ───────────────────────────────────────────────

/** Minimal contract `distillRecordedSkill` consumes. Compatible with
 *  `lib/llm-gateway`'s `complete()` signature plus any handcrafted stub
 *  used in tests. */
export interface LlmCompleter {
  (req: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string }>;
}

export interface DistillSkillInput extends RecordSkillInput {
  /** Model id understood by the supplied completer. Kept opaque here —
   *  llm-gateway resolves it through ModelRegistry / MODEL_MAP. */
  model: string;
}

export interface ProposedParameter {
  name: string;
  schema: { type: string; default?: unknown; description?: string };
  /** One or more (stepIndex, argPath) targets where this param substitutes the
   *  recorded literal. argPath is a dot-path into `recorded[stepIndex].args`,
   *  e.g. `"msg"` or `"target.name"`. */
  appliesTo: Array<{ stepIndex: number; argPath: string }>;
}

export interface DistilledMetadata {
  description: { zh: string; en: string };
  /** Narrative markdown. Empty string when LLM declined to produce one. */
  proseMd: string;
  /** LLM-proposed input parameters that lift recorded literals into typed
   *  inputs. Empty when the LLM didn't propose any (or proposed none survived
   *  validation); skill replays the verbatim recording in that case. */
  parameters: ProposedParameter[];
  /** Whether the LLM step actually populated the metadata (false ⇒ fallback). */
  llmApplied: boolean;
  /** When llmApplied=false, the reason (parse error, transport error, etc.). */
  fallbackReason?: string;
}

export type DistillSkillResult =
  | (Extract<RecordSkillResult, { ok: true }> & {
      distilled: DistilledMetadata;
      /** Path to the sidecar `skill.md`, only present when prose was written. */
      proseMdPath?: string;
    })
  | Extract<RecordSkillResult, { ok: false }>;

const DISTILL_SYSTEM_PROMPT = `You are a senior plugin author. The user recorded a sequence of tool calls and wants a polished skill.

Reply with ONE strict JSON object — no prose, no fences. Shape:
{
  "description": { "zh": "<one-sentence Chinese summary>", "en": "<one-sentence English summary>" },
  "prose": "<markdown body, 1-3 short paragraphs, may include a numbered list of steps>",
  "parameters": [
    {
      "name": "<camelCase param name>",
      "schema": { "type": "string"|"number"|"boolean", "default": <recorded literal>, "description": "<one-line>" },
      "appliesTo": [{ "stepIndex": <int>, "argPath": "<dot.path inside recorded args>" }]
    }
  ]
}

Constraints:
- description.zh and description.en must each be ONE sentence under 120 chars.
- prose must be valid markdown without front-matter, under 800 chars.
- parameters lifts recorded LITERAL args into typed inputs. Only propose a parameter when a recorded literal looks like it varies across runs (e.g. a name, a count, a target id). Constants stay verbatim. Empty array is valid.
- argPath is a dot-path into the step's args object — e.g. \"msg\", \"target.name\". stepIndex is 0-based.
- schema.default MUST equal the literal currently recorded at (stepIndex, argPath) — that preserves replay semantics.
- Do not invent tools that weren't in the recorded list.
- Do not include the JSON shape in your reply.`;

function buildDistillUserPrompt(input: DistillSkillInput): string {
  const steps = input.recorded
    .map((r, i) => `${i + 1}. ${r.toolId} ${JSON.stringify(r.args ?? {})}`)
    .join('\n');
  const initial = input.description ?? { zh: '', en: '' };
  return [
    `Plugin id: ${input.pluginId}`,
    `Skill id:  ${input.skillId}`,
    `Display:   ${input.displayName.zh} / ${input.displayName.en}`,
    initial.zh || initial.en
      ? `Initial description (caller provided):\n  zh: ${initial.zh}\n  en: ${initial.en}`
      : '',
    `Recorded sequence (verbatim):\n${steps}`,
    `Produce the JSON object now.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Try hard to extract a JSON object from `text`. Models love wrapping
 *  the payload in a fence or a leading sentence; we strip both. */
function parseDistillResponse(
  text: string,
): { description: { zh: string; en: string }; prose: string; parameters: ProposedParameter[] } | null {
  let s = text.trim();
  // Strip any ```json ... ``` fence.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Find the outermost {…}.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const desc = obj.description as Record<string, unknown> | undefined;
  if (!desc || typeof desc.zh !== 'string' || typeof desc.en !== 'string') return null;
  const prose = typeof obj.prose === 'string' ? obj.prose : '';
  const parameters = Array.isArray(obj.parameters)
    ? (obj.parameters as unknown[]).flatMap((p): ProposedParameter[] => {
        if (!p || typeof p !== 'object') return [];
        const o = p as Record<string, unknown>;
        if (typeof o.name !== 'string' || o.name.length === 0) return [];
        if (!o.schema || typeof o.schema !== 'object') return [];
        const sch = o.schema as Record<string, unknown>;
        if (typeof sch.type !== 'string') return [];
        if (!Array.isArray(o.appliesTo) || o.appliesTo.length === 0) return [];
        const appliesTo = (o.appliesTo as unknown[]).flatMap((a) => {
          if (!a || typeof a !== 'object') return [];
          const at = a as Record<string, unknown>;
          if (typeof at.stepIndex !== 'number' || !Number.isInteger(at.stepIndex) || at.stepIndex < 0) return [];
          if (typeof at.argPath !== 'string' || at.argPath.length === 0) return [];
          return [{ stepIndex: at.stepIndex, argPath: at.argPath }];
        });
        if (appliesTo.length === 0) return [];
        return [{
          name: o.name,
          schema: {
            type: sch.type,
            default: sch.default,
            description: typeof sch.description === 'string' ? sch.description : undefined,
          },
          appliesTo,
        }];
      })
    : [];
  return {
    description: { zh: desc.zh.trim(), en: desc.en.trim() },
    prose: prose.trim(),
    parameters,
  };
}

/** Filter a proposed-parameter list against the actual recorded sequence:
 *  - argPath must address a value in the recorded args
 *  - param `name` must be a valid identifier and unique
 *  - Stable order, dedup, drop bad entries silently */
function validateParameters(
  proposed: ProposedParameter[],
  recorded: RecordedToolCall[],
): ProposedParameter[] {
  const seen = new Set<string>();
  const out: ProposedParameter[] = [];
  for (const p of proposed) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name)) continue;
    if (seen.has(p.name)) continue;
    const validTargets = p.appliesTo.filter((a) => {
      if (a.stepIndex >= recorded.length) return false;
      const args = recorded[a.stepIndex].args;
      return readArgPath(args, a.argPath) !== undefined;
    });
    if (validTargets.length === 0) continue;
    seen.add(p.name);
    out.push({ ...p, appliesTo: validTargets });
  }
  return out;
}

function readArgPath(args: unknown, path: string): unknown {
  if (args === null || args === undefined) return undefined;
  const parts = path.split('.');
  let cur: unknown = args;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Record + LLM-distill a sequence of tool calls into an L2 plugin.
 *  Failure of the LLM step degrades to the deterministic baseline —
 *  the loop always closes. */
export async function distillRecordedSkill(
  input: DistillSkillInput,
  complete: LlmCompleter,
): Promise<DistillSkillResult> {
  // Build the deterministic write-set first so we can hand the LLM the
  // exact `description` we'll fall back to on failure.
  const fallbackDescription = input.description ?? {
    zh: `回放 ${input.recorded.length} 步：由 record-as-skill 自动生成`,
    en: `Replays ${input.recorded.length} step(s) — auto-generated from record-as-skill`,
  };

  let distilled: DistilledMetadata = {
    description: fallbackDescription,
    proseMd: '',
    parameters: [],
    llmApplied: false,
    fallbackReason: 'not-attempted',
  };

  try {
    const resp = await complete({
      model: input.model,
      messages: [
        { role: 'system', content: DISTILL_SYSTEM_PROMPT },
        { role: 'user', content: buildDistillUserPrompt(input) },
      ],
      temperature: 0.2,
      maxTokens: 800,
    });
    const parsed = parseDistillResponse(resp.text);
    if (parsed) {
      // Validate parameters against the recording before handing them to
      // the writer. Bad entries drop silently — the synthesized skill still
      // works, it just falls back to verbatim replay for those slots.
      const validParams = validateParameters(parsed.parameters, input.recorded);
      distilled = {
        description: parsed.description,
        proseMd: parsed.prose,
        parameters: validParams,
        llmApplied: true,
      };
    } else {
      distilled = {
        description: fallbackDescription,
        proseMd: '',
        parameters: [],
        llmApplied: false,
        fallbackReason: 'parse_error',
      };
    }
  } catch (err) {
    distilled = {
      description: fallbackDescription,
      proseMd: '',
      parameters: [],
      llmApplied: false,
      fallbackReason: err instanceof Error ? err.message : String(err),
    };
  }

  // Run the deterministic writer with the (possibly LLM-enriched) metadata.
  // Reuses the existing path-jail / dup-check guard.
  const baseResult = recordAsSkill({
    ...input,
    description: distilled.description,
    parameters: distilled.parameters,
  });
  if (!baseResult.ok) return baseResult;

  // Sidecar prose only when the LLM actually wrote one.
  let proseMdPath: string | undefined;
  if (distilled.llmApplied && distilled.proseMd.length > 0) {
    proseMdPath = join(baseResult.pluginDir, 'skill.md');
    writeFileSync(proseMdPath, distilled.proseMd + '\n', 'utf-8');
  }

  return { ...baseResult, distilled, proseMdPath };
}
