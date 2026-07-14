/**
 * Phase B2 — skill kind loader.
 *
 * Normalizes the loose `provides.skills[]` manifest shape (which may use
 * `entry: "./SKILL.md"` or `trigger: "/cmd"` shorthand) into the strict
 * SkillDefinition contract that downstream resolvers/runners expect.
 *
 * Lookup-only at this phase — the runner lands in D4. Both kind=skill and
 * kind=workbench/agent plugins can declare `provides.skills`, so this loader
 * runs against any merged manifest and emits one entry per skill found.
 */
import { dirname } from 'node:path';
import type { ManifestSkillEntry, SkillDefinition, SkillEntry, SkillTrigger } from '@forgeax/types';
import type { MergedManifest } from '../merger';
import type { SkillEntry as RegistryEntry, KindLoadIssue } from './types';

interface ProvidesWithSkills {
  skills?: ManifestSkillEntry[];
}

function normalizeEntry(
  raw: ManifestSkillEntry['entry'],
  fallbackId: string,
): { entry: SkillEntry; warning?: string } {
  if (!raw) {
    return {
      entry: { kind: 'prompt', file: `./skills/${fallbackId}.md` },
      warning: `skill ${fallbackId} has no entry; defaulting to prompt`,
    };
  }
  if (typeof raw === 'string') {
    return { entry: { kind: 'prompt', file: raw } };
  }
  return { entry: raw };
}

function normalizeTriggers(s: ManifestSkillEntry): { triggers: SkillTrigger[]; warning?: string } {
  if (s.triggers && s.triggers.length > 0) return { triggers: s.triggers };
  if (typeof s.trigger === 'string' && s.trigger.length > 0) {
    const cmd = s.trigger.startsWith('/') ? s.trigger.slice(1) : s.trigger;
    return { triggers: [{ kind: 'slash', command: cmd }] };
  }
  // No declared trigger → derive `/${id}` as a sensible default. agentskills.io
  // format doesn't mandate triggers (inline default-skills auto-load through
  // an agent's `defaultSkills` ref), so we just install the fallback silently
  // instead of emitting a warning every author would have to suppress.
  return { triggers: [{ kind: 'slash', command: s.id }] };
}

export function loadSkills(
  merged: MergedManifest,
): { entries: RegistryEntry[]; issues: KindLoadIssue[] } {
  const out: { entries: RegistryEntry[]; issues: KindLoadIssue[] } = { entries: [], issues: [] };
  const m = merged.manifest;
  const provides = m.provides as ProvidesWithSkills | undefined;
  const skills = provides?.skills;
  if (!skills?.length) return out;

  for (const s of skills) {
    const { entry, warning: ew } = normalizeEntry(s.entry, s.id);
    const { triggers, warning: tw } = normalizeTriggers(s);
    if (ew) out.issues.push({ kind: 'skill', pluginId: m.id, reason: ew });
    if (tw) out.issues.push({ kind: 'skill', pluginId: m.id, reason: tw });

    const def: SkillDefinition = {
      id: s.id,
      entry,
      triggers,
      requiresTools: s.requiresTools,
      permissions: s.permissions,
      io: s.io,
      timeoutMs: s.timeoutMs,
      displayName: s.displayName ?? { zh: s.id, en: s.id },
      description: s.description ?? { zh: '', en: '' },
    };
    out.entries.push({
      pluginId: m.id,
      layer: merged.layer,
      definition: def,
      originDir: dirname(merged.originPath),
    });
  }
  return out;
}
