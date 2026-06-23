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
import { reloadPlugins, _resetSnapshotForTests } from '../src/plugins/registry';
import {
  composeSystemPrompt,
  listAgents,
  lookupAgent,
  resolveSkill,
} from '../src/agents/loader';

const TMP = `/tmp/forgeax-agent-loader-${process.pid}`;

function mkmanifest(layer: 'L0' | 'L1' | 'L2', dirName: string, body: Record<string, unknown>): string {
  const dir = join(TMP, layer, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'forgeax-plugin.json'),
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
      id: '@forgeax-plugin/agent-iori',
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
    await reloadPlugins({ roots: ROOTS() });

    expect(listAgents().length).toBe(1);
    const e = lookupAgent('iori');
    expect(e?.definition.id).toBe('iori');
    expect(e?.pluginId).toBe('@forgeax-plugin/agent-iori');
    expect(lookupAgent('does-not-exist')).toBeNull();
  });

  it('composeSystemPrompt concatenates persona + prompt-skill body', async () => {
    const agentDir = mkmanifest('L0', 'agent-iori', {
      id: '@forgeax-plugin/agent-iori',
      kind: 'agent',
      displayName: { zh: 'iori' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
          defaultSkills: [{ source: 'plugin', pluginId: '@forgeax-plugin/skill-foo', skillId: 'foo' }],
        },
      },
    });
    writeFileSync(join(agentDir, 'PERSONA.md'), 'PERSONA-BODY', 'utf-8');

    const skillDir = mkmanifest('L0', 'skill-foo', {
      id: '@forgeax-plugin/skill-foo',
      kind: 'skill',
      displayName: { zh: 'foo' },
      provides: { skills: [{ id: 'foo', entry: './SKILL.md', trigger: '/foo' }] },
    });
    writeFileSync(join(skillDir, 'SKILL.md'), 'SKILL-FOO-BODY', 'utf-8');

    await reloadPlugins({ roots: ROOTS() });

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
      id: '@forgeax-plugin/agent-broken',
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
    await reloadPlugins({ roots: ROOTS() });

    const composed = await composeSystemPrompt('broken');
    expect(composed).not.toBeNull();
    expect(composed!.persona).toBe('');
    expect(composed!.warnings.some((w) => w.startsWith('persona file unreadable'))).toBe(true);
  });

  it('records warning for unresolved skill ref', async () => {
    const agentDir = mkmanifest('L0', 'agent-iori', {
      id: '@forgeax-plugin/agent-iori',
      kind: 'agent',
      displayName: { zh: 'iori' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
          defaultSkills: [{ source: 'plugin', pluginId: '@forgeax-plugin/does-not-exist' }],
        },
      },
    });
    writeFileSync(join(agentDir, 'PERSONA.md'), 'P', 'utf-8');
    await reloadPlugins({ roots: ROOTS() });

    const composed = await composeSystemPrompt('iori');
    expect(composed!.skillSections.length).toBe(0);
    expect(composed!.warnings.some((w) => w.startsWith('defaultSkill ref unresolved'))).toBe(true);
  });

  it('resolveSkill matches plugin source and inline source', async () => {
    const skillDir = mkmanifest('L0', 'skill-foo', {
      id: '@forgeax-plugin/skill-foo',
      kind: 'skill',
      displayName: { zh: 'foo' },
      provides: { skills: [{ id: 'foo', entry: './SKILL.md', trigger: '/foo' }] },
    });
    writeFileSync(join(skillDir, 'SKILL.md'), 'X', 'utf-8');
    await reloadPlugins({ roots: ROOTS() });

    const byPlugin = resolveSkill({
      source: 'plugin',
      pluginId: '@forgeax-plugin/skill-foo',
      skillId: 'foo',
    });
    expect(byPlugin?.definition.id).toBe('foo');

    const inlineSame = resolveSkill(
      { source: 'inline', skillId: 'foo' },
      '@forgeax-plugin/skill-foo',
    );
    expect(inlineSame?.definition.id).toBe('foo');

    const inlineNoCtx = resolveSkill({ source: 'inline', skillId: 'foo' });
    expect(inlineNoCtx).toBeNull();

    const inlineWrongCtx = resolveSkill(
      { source: 'inline', skillId: 'foo' },
      '@forgeax-plugin/some-other',
    );
    expect(inlineWrongCtx).toBeNull();
  });

  it('skips ts/py-kind skills in the system prompt (deferred to SkillRunner)', async () => {
    const agentDir = mkmanifest('L0', 'agent-iori', {
      id: '@forgeax-plugin/agent-iori',
      kind: 'agent',
      displayName: { zh: 'iori' },
      provides: {
        agent: {
          id: 'iori',
          role: 'planner',
          card: { name: { zh: 'Iori' }, color: '#1F6FEB', avatar: '🤖' },
          personaFile: './PERSONA.md',
          defaultSkills: [{ source: 'plugin', pluginId: '@forgeax-plugin/skill-ts', skillId: 'tx' }],
        },
      },
    });
    writeFileSync(join(agentDir, 'PERSONA.md'), 'P', 'utf-8');

    mkmanifest('L0', 'skill-ts', {
      id: '@forgeax-plugin/skill-ts',
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
    await reloadPlugins({ roots: ROOTS() });

    const composed = await composeSystemPrompt('iori');
    expect(composed!.skillSections.length).toBe(0);
    expect(composed!.warnings).toEqual([]);
  });

  it('returns null for unknown agent id', async () => {
    await reloadPlugins({ roots: ROOTS() });
    expect(await composeSystemPrompt('nope')).toBeNull();
  });
});
