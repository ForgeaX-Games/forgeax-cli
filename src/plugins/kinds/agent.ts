/**
 * Phase B2 — agent kind loader.
 *
 * Resolves a kind=agent manifest into an AgentEntry, primarily so B5's
 * AgentLoader.composeSystemPrompt() can lookup `personaPath` without
 * re-walking the marketplace tree.
 */
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentDefinition, ResolvedAgentDefinition } from '@forgeax/types';
import type { MergedManifest } from '../merger';
import type { AgentEntry, KindLoadIssue } from './types';
import { loadAvatarRulesCached } from './avatar-rules';

export function loadAgent(
  merged: MergedManifest,
): { entry: AgentEntry | null; issues: KindLoadIssue[] } {
  const m = merged.manifest;
  if (m.kind !== 'agent') return { entry: null, issues: [] };
  const a = m.provides.agent;
  const pluginDir = dirname(merged.originPath);
  const personaPath = resolve(pluginDir, a.personaFile);
  const issues: KindLoadIssue[] = [];
  if (!existsSync(personaPath)) {
    issues.push({
      kind: 'agent',
      pluginId: m.id,
      reason: `personaFile not found: ${personaPath}`,
    });
  }

  // ADR-0019: 解析 avatar 状态机. avatarSet 字段显式指 rulesFile 优先;
  // 不显式声明也尝试默认 ./avatar/AVATAR.md (大多数 agent 都被
  // seed-agent-avatars.sh 自动 seed 过, 这条路径走得通就够了).
  const avatarParsed = loadAvatarRulesCached(pluginDir, a.card.avatarSet?.rulesFile);
  for (const reason of avatarParsed.issues) {
    issues.push({ kind: 'agent', pluginId: m.id, reason: `avatar: ${reason}` });
  }

  const definition: ResolvedAgentDefinition = {
    id: a.id,
    role: a.role,
    card: a.card,
    personaFile: a.personaFile,
    memoryDir: a.memoryDir,
    produces: a.produces,
    preferredCliProvider: a.preferredCliProvider,
    defaultLang: a.defaultLang ?? 'zh',
    multiInstance: a.multiInstance ?? false,
    defaultSkills: a.defaultSkills as AgentDefinition['defaultSkills'],
    tools: a.tools,
    ...(avatarParsed.rules ? { avatarRules: avatarParsed.rules } : {}),
  };
  return {
    entry: { pluginId: m.id, layer: merged.layer, definition, personaPath },
    issues,
  };
}
