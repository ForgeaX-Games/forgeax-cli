/**
 * Phase B2 — Kind dispatcher.
 *
 * Walks every merged manifest and feeds the right per-kind loader. Returns
 * a populated KindRegistry that B3's PluginRegistry.replaceFromManifests
 * swaps into the live host.
 *
 * Skill discovery runs across ALL kinds (workbench/agent/skill plugins can
 * all declare provides.skills), but the per-kind loader for the main kind
 * runs only when the discriminated kind matches.
 */
import type { MergedManifest } from '../merger';
import { loadAgent } from './agent';
import { loadCliProvider } from './cli-provider';
import { loadSkills } from './skill';
import { loadTools } from './tool';
import { loadWorkbench } from './workbench';
import { emptyKindRegistry, type KindRegistry } from './types';

export function buildKindRegistry(manifests: MergedManifest[]): KindRegistry {
  const reg = emptyKindRegistry();
  for (const m of manifests) {
    const wb = loadWorkbench(m);
    if (wb) reg.workbench.push(wb);

    const ag = loadAgent(m);
    if (ag.entry) reg.agents.push(ag.entry);
    reg.issues.push(...ag.issues);

    const sk = loadSkills(m);
    reg.skills.push(...sk.entries);
    reg.issues.push(...sk.issues);

    const cp = loadCliProvider(m);
    if (cp.entry) reg.cliProviders.push(cp.entry);
    reg.issues.push(...cp.issues);

    const tl = loadTools(m);
    reg.tools.push(...tl.entries);
    reg.issues.push(...tl.issues);

    // Phase D stub: model-binding still untouched until the gateway needs it.
    if (m.manifest.kind === 'model-binding') {
      reg.modelBindings.push({ pluginId: m.manifest.id, manifest: m.manifest });
    }
  }
  // Stable sort workbench tabs by position-then-id for a deterministic UI.
  reg.workbench.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.workbenchId.localeCompare(b.workbenchId);
  });
  return reg;
}

export type { KindRegistry, WorkbenchEntry, AgentEntry, SkillEntry, KindLoadIssue } from './types';
export type { CliProviderEntry } from './cli-provider';
export { loadDriverForEntry } from './cli-provider';
export type { ToolEntry } from './tool';
