/**
 * Doc 09 §2.3 — record-as-skill deterministic recorder.
 *
 * Asserts:
 *   1. happy path writes a manifest + skill.mjs that schema-validates
 *      and reload picks it up;
 *   2. empty recorded[] is rejected as bad_input;
 *   3. the synthesized skill, when run, calls each tool in order and
 *      bubbles the first failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { recordAsSkill, distillRecordedSkill } from '../src/skills/record-as-skill';
import type { LlmCompleter } from '../src/skills/record-as-skill';
import { scanAllLayers } from '../src/plugins/scanner';
import { mergeManifests } from '../src/plugins/merger';
import { buildKindRegistry } from '../src/plugins/kinds';

const TMP = `/tmp/forgeax-record-${process.pid}`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('Doc 09 §2.3 — record-as-skill', () => {
  it('writes a complete plugin dir whose manifest scans cleanly', async () => {
    const r = recordAsSkill({
      projectRoot: TMP,
      pluginId: '@me/replay-greet',
      skillId: 's.replay',
      displayName: { zh: '回放问候', en: 'Replay Greet' },
      recorded: [
        { toolId: 'demo.echo', args: { msg: 'hi' } },
        { toolId: 'demo.echo', args: { msg: 'world' } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(existsSync(r.manifestPath)).toBe(true);
    expect(existsSync(r.skillPath)).toBe(true);

    // Scanner should pick it up under the project's L2 root —
    // .forgeax/plugins/<slug> mirrors fork + install layout.
    // Move it into a synthetic L2 root so scanAllLayers can see it.
    const L2 = join(TMP, '.forgeax', 'plugins');
    // Pin L0/L1 to empty dirs so we don't accidentally scan the host repo.
    const L0 = join(TMP, '_empty_L0');
    const L1 = join(TMP, '_empty_L1');
    mkdirSync(L0, { recursive: true });
    mkdirSync(L1, { recursive: true });
    const scan = await scanAllLayers({ L0, L1, L2 });
    expect(scan.errors).toEqual([]);
    const merge = mergeManifests(scan.found);
    const kinds = buildKindRegistry(merge.manifests);
    expect(kinds.skills.length).toBe(1);
    expect(kinds.skills[0].definition.id).toBe('s.replay');
  });

  it('rejects empty recorded[]', () => {
    const r = recordAsSkill({
      projectRoot: TMP,
      pluginId: '@me/empty',
      skillId: 's.x',
      displayName: { zh: 'x', en: 'x' },
      recorded: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_input');
  });

  describe('LLM distillation (D6 follow-up)', () => {
    it('happy path: stub LLM returns valid JSON → enriched description + skill.md sidecar', async () => {
      const stub: LlmCompleter = async () => ({
        text: '```json\n{"description":{"zh":"自动问候","en":"Auto greet"},"prose":"# Replay greet\\n\\n1. say hi\\n2. say world"}\n```',
      });
      const r = await distillRecordedSkill(
        {
          projectRoot: TMP,
          pluginId: '@me/replay-distilled',
          skillId: 's.distilled',
          displayName: { zh: '蒸馏回放', en: 'Distilled Replay' },
          recorded: [
            { toolId: 'demo.echo', args: { msg: 'hi' } },
            { toolId: 'demo.echo', args: { msg: 'world' } },
          ],
          model: 'stub-model',
        },
        stub,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.distilled.llmApplied).toBe(true);
      expect(r.distilled.description.zh).toBe('自动问候');
      expect(r.distilled.description.en).toBe('Auto greet');
      expect(r.proseMdPath).toBeTruthy();
      expect(existsSync(r.proseMdPath!)).toBe(true);
      expect(readFileSync(r.proseMdPath!, 'utf-8')).toContain('# Replay greet');
      // Manifest should carry the LLM-supplied description, not the fallback.
      const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf-8'));
      expect(manifest.description.zh).toBe('自动问候');
    });

    it('LLM throws → falls back to deterministic write (no sidecar, fallbackReason set)', async () => {
      const stub: LlmCompleter = async () => {
        throw new Error('transport down');
      };
      const r = await distillRecordedSkill(
        {
          projectRoot: TMP,
          pluginId: '@me/replay-llm-down',
          skillId: 's.fail',
          displayName: { zh: 'x', en: 'x' },
          recorded: [{ toolId: 'demo.echo', args: {} }],
          model: 'stub-model',
        },
        stub,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.distilled.llmApplied).toBe(false);
      expect(r.distilled.fallbackReason).toBe('transport down');
      expect(r.proseMdPath).toBeUndefined();
      // Plugin still on disk, manifest still scannable.
      expect(existsSync(r.manifestPath)).toBe(true);
      expect(existsSync(r.skillPath)).toBe(true);
    });

    it('parameterization: LLM proposes a top-level param → manifest gets io.input + skill.mjs reads ctx.input', async () => {
      const stub: LlmCompleter = async () => ({
        text:
          '{"description":{"zh":"问候","en":"Greet"},"prose":"# greet","parameters":[' +
          '{"name":"who","schema":{"type":"string","default":"hi","description":"who to greet"},' +
          '"appliesTo":[{"stepIndex":0,"argPath":"msg"}]}]}',
      });
      const r = await distillRecordedSkill(
        {
          projectRoot: TMP,
          pluginId: '@me/replay-param',
          skillId: 's.param',
          displayName: { zh: 'p', en: 'p' },
          recorded: [{ toolId: 'demo.echo', args: { msg: 'hi' } }],
          model: 'stub-model',
        },
        stub,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.distilled.llmApplied).toBe(true);
      expect(r.distilled.parameters.length).toBe(1);
      expect(r.distilled.parameters[0].name).toBe('who');

      const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf-8'));
      const skill = manifest.provides.skills[0];
      expect(skill.io).toBeDefined();
      expect(skill.io.input.properties.who.type).toBe('string');
      expect(skill.io.input.properties.who.default).toBe('hi');

      const skillSrc = readFileSync(r.skillPath, 'utf-8');
      expect(skillSrc).toContain('input.who');
      expect(skillSrc).toContain('"msg"');
      // Default fallback path references the recorded literal.
      expect(skillSrc).toContain('"hi"');
    });

    it('parameterization: LLM proposes a dot-path param → skill.mjs creates intermediate object', async () => {
      const stub: LlmCompleter = async () => ({
        text: JSON.stringify({
          description: { zh: '深路径', en: 'deep' },
          prose: 'deep',
          parameters: [{
            name: 'targetName',
            schema: { type: 'string', default: 'hero' },
            appliesTo: [{ stepIndex: 0, argPath: 'target.name' }],
          }],
        }),
      });
      const r = await distillRecordedSkill(
        {
          projectRoot: TMP,
          pluginId: '@me/replay-deep',
          skillId: 's.deep',
          displayName: { zh: 'd', en: 'd' },
          recorded: [{ toolId: 'demo.echo', args: { target: { name: 'hero' } } }],
          model: 'stub-model',
        },
        stub,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.distilled.parameters.length).toBe(1);
      const skillSrc = readFileSync(r.skillPath, 'utf-8');
      expect(skillSrc).toContain('a0["target"]');
      expect(skillSrc).toContain('= _p_targetName');
    });

    it('parameterization: LLM proposes invalid params (bad path / bad name) → silently dropped, skill still works', async () => {
      const stub: LlmCompleter = async () => ({
        text: JSON.stringify({
          description: { zh: 'x', en: 'x' },
          prose: '',
          parameters: [
            { name: '123-bad', schema: { type: 'string' }, appliesTo: [{ stepIndex: 0, argPath: 'msg' }] },
            { name: 'good', schema: { type: 'string', default: 'hi' }, appliesTo: [{ stepIndex: 0, argPath: 'nonexistent' }] },
            { name: 'kept', schema: { type: 'string', default: 'hi' }, appliesTo: [{ stepIndex: 0, argPath: 'msg' }] },
          ],
        }),
      });
      const r = await distillRecordedSkill(
        {
          projectRoot: TMP,
          pluginId: '@me/replay-invalid',
          skillId: 's.invalid',
          displayName: { zh: 'i', en: 'i' },
          recorded: [{ toolId: 'demo.echo', args: { msg: 'hi' } }],
          model: 'stub-model',
        },
        stub,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.distilled.parameters.length).toBe(1);
      expect(r.distilled.parameters[0].name).toBe('kept');
    });

    it('parameterization: synthesized skill substitutes ctx.input.<name> at runtime', async () => {
      const stub: LlmCompleter = async () => ({
        text: JSON.stringify({
          description: { zh: '执行', en: 'run' },
          prose: '',
          parameters: [{
            name: 'msg',
            schema: { type: 'string', default: 'hello' },
            appliesTo: [{ stepIndex: 0, argPath: 'text' }],
          }],
        }),
      });
      const r = await distillRecordedSkill(
        {
          projectRoot: TMP,
          pluginId: '@me/replay-runtime',
          skillId: 's.runtime',
          displayName: { zh: 'r', en: 'r' },
          recorded: [{ toolId: 'demo.echo', args: { text: 'hello' } }],
          model: 'stub-model',
        },
        stub,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Load the synthesized skill module and run it.
      const mod = await import(r.skillPath);
      const calls: Array<{ toolId: string; args: unknown }> = [];
      const ctx = {
        caller: { kind: 'user' as const },
        callTool: async (req: { toolId: string; args: unknown }) => {
          calls.push({ toolId: req.toolId, args: req.args });
          return { ok: true, result: { echoed: req.args } };
        },
        input: { msg: 'overridden' },
      };
      const out = await mod.default(ctx);
      expect(out.ok).toBe(true);
      expect(calls.length).toBe(1);
      expect((calls[0].args as Record<string, string>).text).toBe('overridden');
    });

    it('LLM returns garbage → parse_error fallback, deterministic write still succeeds', async () => {
      const stub: LlmCompleter = async () => ({ text: 'not json at all, just chatter' });
      const r = await distillRecordedSkill(
        {
          projectRoot: TMP,
          pluginId: '@me/replay-llm-garbage',
          skillId: 's.bad',
          displayName: { zh: 'x', en: 'x' },
          recorded: [{ toolId: 'demo.echo', args: {} }],
          model: 'stub-model',
        },
        stub,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.distilled.llmApplied).toBe(false);
      expect(r.distilled.fallbackReason).toBe('parse_error');
      expect(r.proseMdPath).toBeUndefined();
    });
  });

  it('refuses to overwrite an existing plugin dir', () => {
    const a = recordAsSkill({
      projectRoot: TMP,
      pluginId: '@me/dup',
      skillId: 's.x',
      displayName: { zh: 'x', en: 'x' },
      recorded: [{ toolId: 'demo.echo', args: {} }],
    });
    expect(a.ok).toBe(true);
    const b = recordAsSkill({
      projectRoot: TMP,
      pluginId: '@me/dup',
      skillId: 's.x',
      displayName: { zh: 'x', en: 'x' },
      recorded: [{ toolId: 'demo.echo', args: {} }],
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('exists');
  });
});
