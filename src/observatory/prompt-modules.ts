/** Prompt-module slicer for the Observatory `/inspect` route.
 *
 *  Goal: surface **every byte** the model is shown so the operator can
 *  reason about cache efficiency, scope, and persona influence. The
 *  observatory expects a tree of modules → child sections.
 *
 *  Module layering (matches what `claude-code` provider actually sends):
 *  1. `forgeax_intro`              — preamble of FORGEAX_SYSTEM_PROMPT (everything before the first `## ` heading)
 *  2. each `## heading` block      — material conventions / ECS recipes / workflow / error self-help …
 *  3. `active_game`                — appended only when `buildSystemPrompt(slug)` had a slug
 *  4. `persona`                    — `composeSystemPrompt().persona`, second-level split by `# heading`
 *  5. `skill:<id>` (each)          — `composeSystemPrompt().skillSections`, same H1-split
 *
 *  forgeax-native agents (no claude-code provider in front) only have
 *  layers 4-5 — pass `includeForgeaxScaffold: false` and the slicer
 *  skips the prompt-prepend.
 *
 *  Token estimate: cheap 4-chars-per-token approximation, same heuristic
 *  the observatory frontend already uses on its own bookkeeping. The
 *  number is for rough budget visualization only — not billing.
 */

import { composeSystemPrompt } from '../agents/loader';
import { buildSystemPrompt } from '../cli-providers/providers/claude-code';

export interface ContextBlock {
  id: string;
  tag: string;
  content: string;
  charCount: number;
  estimatedTokens: number;
  percentOfTotal: number;
  children?: ContextBlock[];
}

export interface PromptInspection {
  raw: string;
  charCount: number;
  estimatedTokens: number;
  modules: ContextBlock[];
  warnings: string[];
}

const APPROX_CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/** Split a module body by `^# heading` markdown headings into children.
 *  Anything before the first heading becomes an unnamed "preamble" child
 *  so no characters get dropped. Returns [] when the body has zero `# `
 *  headings (caller renders the parent as a leaf in that case). */
function splitByHeadings(parentId: string, body: string, totalChars: number): ContextBlock[] {
  const lines = body.split('\n');
  const segments: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^#{1,3} (.+)\s*$/.exec(line);
    if (m) {
      if (current) segments.push(current);
      current = { heading: m[1].trim(), lines: [] };
    } else {
      if (!current) current = { heading: '(preamble)', lines: [] };
      current.lines.push(line);
    }
  }
  if (current) segments.push(current);
  if (segments.length <= 1) return [];

  return segments.map((seg, i) => {
    const content = seg.lines.join('\n').trim();
    const charCount = content.length;
    return {
      id: `${parentId}#${i}`,
      tag: seg.heading,
      content,
      charCount,
      estimatedTokens: estimateTokens(content),
      percentOfTotal: totalChars > 0 ? +(charCount / totalChars * 100).toFixed(2) : 0,
    };
  });
}

/** Build a ContextBlock for one top-level module (persona | skill). */
function makeTopLevel(id: string, tag: string, body: string, totalChars: number): ContextBlock {
  const trimmed = body.trim();
  const charCount = trimmed.length;
  const children = splitByHeadings(id, trimmed, totalChars);
  return {
    id,
    tag,
    content: trimmed,
    charCount,
    estimatedTokens: estimateTokens(trimmed),
    percentOfTotal: totalChars > 0 ? +(charCount / totalChars * 100).toFixed(2) : 0,
    ...(children.length > 0 ? { children } : {}),
  };
}

/** Slice the FORGEAX claude-code scaffold prompt (`buildSystemPrompt(slug)` →
 *  big templated string) into one ContextBlock per `## heading` section, plus
 *  a leading `forgeax_intro` block holding everything before the first heading.
 *
 *  When `slug` is set, `buildSystemPrompt` appends a final paragraph
 *  ("The currently-active game is `slug`...") that has no `## ` marker — we
 *  detect it via the literal "currently-active game is" substring and split
 *  it off as `active_game`. This lets the operator see *and* verify scope
 *  scoping decisions at a glance.
 */
function sliceForgeaxScaffold(scaffold: string, totalChars: number): ContextBlock[] {
  if (!scaffold) return [];

  // Pull off the "active_game" trailer if present — it lives after the last
  // `## heading` block and is appended by `buildSystemPrompt(slug)`.
  let activeGame: string | null = null;
  let body = scaffold;
  const activeMatch = scaffold.match(/(\n+The currently-active game is[\s\S]*)$/);
  if (activeMatch && activeMatch.index !== undefined) {
    activeGame = activeMatch[1].trim();
    body = scaffold.slice(0, activeMatch.index);
  }

  const lines = body.split('\n');
  const segments: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } = { heading: 'forgeax_intro', lines: [] };
  for (const line of lines) {
    const m = /^## (.+)\s*$/.exec(line);
    if (m) {
      segments.push(current);
      current = { heading: m[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  segments.push(current);

  const blocks: ContextBlock[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const content = seg.lines.join('\n').trim();
    if (!content) continue;
    const id = i === 0 ? 'forgeax_intro' : `forgeax_section:${i}`;
    blocks.push(makeTopLevel(id, seg.heading, content, totalChars));
  }
  if (activeGame) {
    blocks.push(makeTopLevel('active_game', 'active_game', activeGame, totalChars));
  }
  return blocks;
}

export interface InspectOptions {
  /** Forwarded to `buildSystemPrompt(slug)` so the active-game trailer
   *  appears in the slice when the session has one. */
  activeSlug?: string;
  /** When false, only persona + skills are included (forgeax-native agents
   *  that don't go through the claude-code provider). Default true. */
  includeForgeaxScaffold?: boolean;
}

/** Compose + slice the full system prompt for one agent.
 *  Returns null when the agent id can't be resolved at all (caller should
 *  404). When persona/skill files are partially unreadable the warnings
 *  array carries the details and what we did manage to read still slices. */
export async function inspectAgentPrompt(
  agentId: string,
  opts: InspectOptions = {},
): Promise<PromptInspection | null> {
  const composed = await composeSystemPrompt(agentId);
  if (!composed) return null;

  const includeScaffold = opts.includeForgeaxScaffold !== false;
  const scaffold = includeScaffold ? buildSystemPrompt(opts.activeSlug) : '';

  // Reproduce exactly what claude-code sends to the model so token
  // accounting matches the wire payload (see claude-code.ts:401).
  const personaText = composed.text.trim();
  const raw = scaffold && personaText
    ? `${scaffold}\n\n---\n\n## Persona\n\n${personaText}`
    : (scaffold || personaText);
  const totalChars = raw.length;

  const modules: ContextBlock[] = [];

  // 1) FORGEAX scaffold (intro + per-section + active_game trailer)
  if (includeScaffold) {
    modules.push(...sliceForgeaxScaffold(scaffold, totalChars));
  }

  // 2) persona + skills (composeSystemPrompt result)
  if (composed.persona && composed.persona.trim().length > 0) {
    modules.push(makeTopLevel('persona', 'persona', composed.persona, totalChars));
  }
  for (const sec of composed.skillSections) {
    modules.push(makeTopLevel(`skill:${sec.skillId}`, `skill:${sec.skillId}`, sec.body, totalChars));
  }

  return {
    raw,
    charCount: totalChars,
    estimatedTokens: estimateTokens(raw),
    modules,
    warnings: composed.warnings,
  };
}
