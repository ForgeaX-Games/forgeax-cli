/**
 * Phase B5 — AgentLoader unit tests.
 *
 * Builds disposable plugins on disk (agent persona + prompt skill md) and
 * checks listAgents / lookupAgent / resolveSkill / composeSystemPrompt
 * against the live registry snapshot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reloadExtensions, _resetSnapshotForTests } from '../src/extensions/registry';
import {
  composeSystemPrompt,
  listAgents,
  lookupAgent,
  resolveSkill,
} from '../src/agents/loader';
import { loadAgentRecord } from '../src/soul';

const TMP = `/tmp/forgeax-agent-loader-${process.pid}`;

function mkmanifest(layer: 'L0' | 'L1' | 'L2', dirName: string, body: Record<string, unknown>): string {
  const dir = join(TMP, layer, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-extension.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', ...body }),
    'utf-8',
  );
  return dir;
}

const ROOTS = () => ({
  L0: join(TMP, 'L0'),
  L1: join(TMP, 'L1'),
  L2: join(TMP, 'L2'),
});

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const l of ['L0', 'L1', 'L2'] as const) mkdirSync(join(TMP, l), { recursive: true });
  _resetSnapshotForTests();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  _resetSnapshotForTests();
});

describe('AgentLoader', () => {
  it('listAgents/lookupAgent reflect registered agents', async () => {
    const dir = mkmanifest('L0', 'agent-iori', {
      id: '@forgeax-extension/agent-iori',
      kind: 'agent',
      displayName: { zh: 'iori' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
        },
      },
    });
    writeFileSync(join(dir, 'PERSONA.md'), '# Iori persona body\n', 'utf-8');
    await reloadExtensions({ roots: ROOTS() });

    expect(listAgents().length).toBe(1);
    const e = lookupAgent('iori');
    expect(e?.definition.id).toBe('iori');
    expect(e?.pluginId).toBe('@forgeax-extension/agent-iori');
    expect(lookupAgent('does-not-exist')).toBeNull();
  });

  it('treats extension-provided agents as imported souls', async () => {
    const dir = mkmanifest('L1', 'agent-poly', {
      id: '@forgeax-extension/agent-poly',
      kind: 'agent',
      displayName: { zh: 'poly' },
      provides: {
        agent: {
          id: 'poly',
          role: 'modeling',
          card: { name: { zh: 'Poly' }, color: '#56B6C2', avatar: 'P' },
          personaFile: './PERSONA.md',
        },
      },
    });
    writeFileSync(join(dir, 'PERSONA.md'), '# Poly persona\n', 'utf-8');
    await reloadExtensions({ roots: ROOTS() });

    const record = await loadAgentRecord('poly', { projectRoot: TMP });
    expect(record.source).toBe('marketplace');
    expect(record.trustTier).toBe('imported');
  });

  it('treats host-bundled L0 extension agents as own souls', async () => {
    const dir = mkmanifest('L0', 'agent-bundled-poly', {
      id: '@forgeax-extension/agent-bundled-poly',
      kind: 'agent',
      displayName: { zh: 'bundled-poly' },
      provides: {
        agent: {
          id: 'bundled-poly',
          role: 'modeling',
          card: { name: { zh: 'Bundled Poly' }, color: '#56B6C2', avatar: 'P' },
          personaFile: './PERSONA.md',
        },
      },
    });
    writeFileSync(join(dir, 'PERSONA.md'), '# Bundled Poly persona\n', 'utf-8');
    await reloadExtensions({ roots: ROOTS() });

    const record = await loadAgentRecord('bundled-poly', { projectRoot: TMP });
    expect(record.source).toBe('builtin');
    expect(record.trustTier).toBe('own');
  });

  it('composeSystemPrompt concatenates persona + prompt-skill body', async () => {
    const agentDir = mkmanifest('L0', 'agent-iori', {
      id: '@forgeax-extension/agent-iori',
      kind: 'agent',
      displayName: { zh: 'iori' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
          defaultSkills: [{ source: 'plugin', pluginId: '@forgeax-extension/skill-foo', skillId: 'foo' }],
        },
      },
    });
    writeFileSync(join(agentDir, 'PERSONA.md'), 'PERSONA-BODY', 'utf-8');

    const skillDir = mkmanifest('L0', 'skill-foo', {
      id: '@forgeax-extension/skill-foo',
      kind: 'skill',
      displayName: { zh: 'foo' },
      provides: { skills: [{ id: 'foo', entry: './SKILL.md', trigger: '/foo' }] },
    });
    writeFileSync(join(skillDir, 'SKILL.md'), 'SKILL-FOO-BODY', 'utf-8');

    await reloadExtensions({ roots: ROOTS() });

    const composed = await composeSystemPrompt('iori');
    expect(composed).not.toBeNull();
    expect(composed!.persona).toContain('PERSONA-BODY');
    expect(composed!.skillSections.length).toBe(1);
    expect(composed!.skillSections[0].body).toContain('SKILL-FOO-BODY');
    expect(composed!.text).toContain('PERSONA-BODY');
    expect(composed!.text).toContain('## Skill: foo');
    expect(composed!.text).toContain('SKILL-FOO-BODY');
    expect(composed!.warnings).toEqual([]);
  });

  it('records warning when persona file is unreadable', async () => {
    mkmanifest('L0', 'agent-broken', {
      id: '@forgeax-extension/agent-broken',
      kind: 'agent',
      displayName: { zh: 'broken' },
      provides: {
        agent: {
          id: 'broken',
          role: 'planner',
          card: { name: { zh: 'B' }, color: '#fff', avatar: 'X' },
          personaFile: './MISSING.md',
        },
      },
    });
    await reloadExtensions({ roots: ROOTS() });

    const composed = await composeSystemPrompt('broken');
    expect(composed).not.toBeNull();
    expect(composed!.persona).toBe('');
    expect(composed!.warnings.some((w) => w.startsWith('persona file unreadable'))).toBe(true);
  });

  it('records warning for unresolved skill ref', async () => {
    const agentDir = mkmanifest('L0', 'agent-iori', {
      id: '@forgeax-extension/agent-iori',
      kind: 'agent',
      displayName: { zh: 'iori' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
          defaultSkills: [{ source: 'plugin', pluginId: '@forgeax-extension/does-not-exist' }],
        },
      },
    });
    writeFileSync(join(agentDir, 'PERSONA.md'), 'P', 'utf-8');
    await reloadExtensions({ roots: ROOTS() });

    const composed = await composeSystemPrompt('iori');
    expect(composed!.skillSections.length).toBe(0);
    expect(composed!.warnings.some((w) => w.startsWith('defaultSkill ref unresolved'))).toBe(true);
  });

  it('resolveSkill matches plugin source and inline source', async () => {
    const skillDir = mkmanifest('L0', 'skill-foo', {
      id: '@forgeax-extension/skill-foo',
      kind: 'skill',
      displayName: { zh: 'foo' },
      provides: { skills: [{ id: 'foo', entry: './SKILL.md', trigger: '/foo' }] },
    });
    writeFileSync(join(skillDir, 'SKILL.md'), 'X', 'utf-8');
    await reloadExtensions({ roots: ROOTS() });

    const byPlugin = resolveSkill({
      source: 'plugin',
      pluginId: '@forgeax-extension/skill-foo',
      skillId: 'foo',
    });
    expect(byPlugin?.definition.id).toBe('foo');

    const inlineSame = resolveSkill(
      { source: 'inline', skillId: 'foo' },
      '@forgeax-extension/skill-foo',
    );
    expect(inlineSame?.definition.id).toBe('foo');

    const inlineNoCtx = resolveSkill({ source: 'inline', skillId: 'foo' });
    expect(inlineNoCtx).toBeNull();

    const inlineWrongCtx = resolveSkill(
      { source: 'inline', skillId: 'foo' },
      '@forgeax-extension/some-other',
    );
    expect(inlineWrongCtx).toBeNull();
  });

  it('skips ts/py-kind skills in the system prompt (deferred to SkillRunner)', async () => {
    const agentDir = mkmanifest('L0', 'agent-iori', {
      id: '@forgeax-extension/agent-iori',
      kind: 'agent',
      displayName: { zh: 'iori' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
          defaultSkills: [{ source: 'plugin', pluginId: '@forgeax-extension/skill-ts', skillId: 'tx' }],
        },
      },
    });
    writeFileSync(join(agentDir, 'PERSONA.md'), 'P', 'utf-8');

    mkmanifest('L0', 'skill-ts', {
      id: '@forgeax-extension/skill-ts',
      kind: 'skill',
      displayName: { zh: 'tx' },
      provides: {
        skills: [{
          id: 'tx',
          entry: { kind: 'ts', file: './run.ts' },
          triggers: [{ kind: 'slash', command: 'tx' }],
        }],
      },
    });
    await reloadExtensions({ roots: ROOTS() });

    const composed = await composeSystemPrompt('iori');
    expect(composed!.skillSections.length).toBe(0);
    expect(composed!.warnings).toEqual([]);
  });

  it('returns null for unknown agent id', async () => {
    await reloadExtensions({ roots: ROOTS() });
    expect(await composeSystemPrompt('nope')).toBeNull();
  });
});
