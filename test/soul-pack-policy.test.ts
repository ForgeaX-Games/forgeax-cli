/**
 * soul-pack manifest.json 声明式策略解析 —— promptMode + toolPolicy。
 *
 * 背景:R4-13 让 pack 经 manifest.json 从外部收口系统提示词模式与工具面。
 * manifest 此前只判存在、从不解析;本文件钉住解析行为 + trustTier 仍按路径(R6-02)。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRecord } from '../src/soul';

let TMP = '';
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'fx-soulpol-'));
});
afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

/** 在 imported 来源(.forgeax/souls-imported/<id>)落一个 pack:identity + manifest。 */
function writePack(id: string, manifest: unknown): void {
  const dir = join(TMP, '.forgeax', 'souls-imported', id);
  mkdirSync(join(dir, 'persona'), { recursive: true });
  writeFileSync(join(dir, 'persona', 'identity.md'), `# ${id}\nI am ${id}.`);
  if (manifest !== undefined) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('manifest 策略解析', () => {
  test('systemPrompt.mode + tools.allow/deny → AgentRecord', async () => {
    writePack('alpha', {
      systemPrompt: { mode: 'replace' },
      tools: { allow: ['Read', 'Grep'], deny: ['Bash', 'Write'] },
    });
    const rec = await loadAgentRecord('alpha', { projectRoot: TMP });
    expect(rec.promptMode).toBe('replace');
    expect(rec.toolPolicy).toEqual({ allow: ['Read', 'Grep'], deny: ['Bash', 'Write'] });
    // trustTier 权威 = 路径(souls-imported → imported),与 manifest 无关。
    expect(rec.trustTier).toBe('imported');
  });

  test('无 manifest(仅 identity)→ 策略字段 undefined(零回归)', async () => {
    writePack('beta', undefined);
    const rec = await loadAgentRecord('beta', { projectRoot: TMP });
    expect(rec.promptMode).toBeUndefined();
    expect(rec.toolPolicy).toBeUndefined();
  });

  test('manifest 无策略键 → 字段 undefined', async () => {
    writePack('gamma', { name: 'Gamma', version: '1.0.0' });
    const rec = await loadAgentRecord('gamma', { projectRoot: TMP });
    expect(rec.promptMode).toBeUndefined();
    expect(rec.toolPolicy).toBeUndefined();
  });

  test('非法 mode 被忽略 + 记 warning;仅 deny 时 allow 省略', async () => {
    writePack('delta', { systemPrompt: { mode: 'bogus' }, tools: { deny: ['Bash'] } });
    const rec = await loadAgentRecord('delta', { projectRoot: TMP });
    expect(rec.promptMode).toBeUndefined();
    expect(rec.toolPolicy).toEqual({ deny: ['Bash'] });
    expect(rec.warnings.some((w) => w.includes('systemPrompt.mode'))).toBe(true);
  });

  test('budget.maxTurns/maxBudgetUsd → AgentRecord.budget;非正值忽略', async () => {
    writePack('zeta', { budget: { maxTurns: 5, maxBudgetUsd: 2 } });
    const rec = await loadAgentRecord('zeta', { projectRoot: TMP });
    expect(rec.budget).toEqual({ maxTurns: 5, maxBudgetUsd: 2 });

    writePack('zeta2', { budget: { maxTurns: 0, maxBudgetUsd: -3 } });
    const rec2 = await loadAgentRecord('zeta2', { projectRoot: TMP });
    expect(rec2.budget).toBeUndefined();
  });

  test('坏 JSON → 不崩,策略空 + warning', async () => {
    const dir = join(TMP, '.forgeax', 'souls-imported', 'epsilon');
    mkdirSync(join(dir, 'persona'), { recursive: true });
    writeFileSync(join(dir, 'persona', 'identity.md'), '# epsilon');
    writeFileSync(join(dir, 'manifest.json'), '{ not valid json');
    const rec = await loadAgentRecord('epsilon', { projectRoot: TMP });
    expect(rec.promptMode).toBeUndefined();
    expect(rec.toolPolicy).toBeUndefined();
    expect(rec.warnings.some((w) => w.includes('manifest.json'))).toBe(true);
  });
});
