/**
 * Phase B2 — KindLoader registry contracts.
 *
 * Each Kind owns one slice of derived state computed from a merged manifest:
 *   workbench  → tab metadata for the Sidebar/MainArea strip
 *   skill      → SkillDefinition (lookup-only; runner lands in Phase D)
 *   agent      → AgentDefinition (lookup; loader.composeSystemPrompt in B5)
 *
 * The KindRegistry is the union container that Phase B3 wraps inside the
 * outer PluginRegistry. Loading is deterministic and idempotent: replaying
 * the same manifest list produces the same KindRegistry contents.
 */
import type {
  AgentDefinition,
  ResolvedAgentDefinition,
  SkillDefinition,
  ExtensionManifest,
} from '@forgeax/types';
import type { ExtensionLayer } from '../scanner';
import type { CliProviderEntry } from './cli-provider';
import type { ToolEntry } from './tool';

export interface WorkbenchEntry {
  extensionId: string;
  layer: ExtensionLayer;
  workbenchId: string;
  position: number;
  panelSize: 'sm' | 'md' | 'lg';
  hidden: boolean;
  surface?: string;
  hasStandalone: boolean;
}

export interface AgentEntry {
  extensionId: string;
  layer: ExtensionLayer;
  /** Resolved 包含 avatarRules 等运行时附加字段; 大部分 callsite 只读 AgentDefinition 字段. */
  definition: ResolvedAgentDefinition;
  /** Absolute path to the persona .md (resolved at load time). */
  personaPath: string;
}

// AgentDefinition 仍然导出供 schema-only 的下游 (host SDK / plugin 校验) 使用.
export type { AgentDefinition };

export interface SkillEntry {
  extensionId: string;
  layer: ExtensionLayer;
  definition: SkillDefinition;
  /** Absolute path to the plugin dir holding this skill — runner resolves
   *  `definition.entry.file` against this. */
  originDir: string;
}

export interface KindLoadIssue {
  kind: 'workbench' | 'agent' | 'skill' | 'cli-provider' | 'model-binding' | 'tool';
  extensionId: string;
  reason: string;
}

export interface KindRegistry {
  workbench: WorkbenchEntry[];
  agents: AgentEntry[];
  skills: SkillEntry[];
  /** Phase C3 — cli-provider entries (real loader). */
  cliProviders: CliProviderEntry[];
  /** Stub registry reserved for Phase D (model-binding still kind-stub). */
  modelBindings: Array<{ extensionId: string; manifest: ExtensionManifest }>;
  /** Phase D1 — flat list of every tool from every kind's `provides.tools[]`. */
  tools: ToolEntry[];
  issues: KindLoadIssue[];
}

export function emptyKindRegistry(): KindRegistry {
  return {
    workbench: [],
    agents: [],
    skills: [],
    cliProviders: [],
    modelBindings: [],
    tools: [],
    issues: [],
  };
}
