/**
 * T3 — CWE-22 path hardening (validateTargetPath) + engine integration.
 *
 * Two-tier verdict: deny (NUL/control char / write-glob) is bypass/rule-immune;
 * forced-ask (write escapes cwd) presses over always-allow / acceptEdits / bypass but
 * stays an approvable prompt. Reads are not cwd-confined; `$`/`~` filenames are NOT
 * mis-rejected (core paths never re-enter a shell).
 */
import { test, expect, describe } from 'bun:test';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { validateTargetPath } from '../src/permission/path-validation';
import { hasPermissionsToUseTool } from '../src/permission/engine';
import { buildTool, type ToolContext } from '../src/capability/types';
import type { PermissionRuleSet } from '../src/permission/rules';

const CWD = '/repo';
const NO_RULES: PermissionRuleSet = { deny: [], ask: [], allow: [] };

function ctxCwd(cwd: string): ToolContext {
  return { signal: new AbortController().signal, cwd } as ToolContext;
}
function writeTool(name = 'write_file') {
  return buildTool({
    name,
    checkPermissions: async (i: unknown) => ({ behavior: 'allow' as const, updatedInput: i }),
    call: async (i: unknown) => ({ data: i }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}
function readTool(name = 'read_file') {
  return buildTool({
    name,
    isReadOnly: () => true,
    checkPermissions: async (i: unknown) => ({ behavior: 'allow' as const, updatedInput: i }),
    call: async (i: unknown) => ({ data: i }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

describe('validateTargetPath — pure function', () => {
  test('NUL byte → deny (any op)', () => {
    expect(validateTargetPath('/repo/a\x00b', 'write', CWD)).toMatchObject({ verdict: 'deny', scope: 'control-char' });
    expect(validateTargetPath('/repo/a\x00b', 'read', CWD)).toMatchObject({ verdict: 'deny' });
  });

  test('C0 control char → deny', () => {
    expect(validateTargetPath('/repo/a\x01b.txt', 'write', CWD).verdict).toBe('deny');
    expect(validateTargetPath('/repo/tab\tname.txt', 'write', CWD).verdict).toBe('deny');
  });

  test('write-glob `*` / `?` → deny', () => {
    expect(validateTargetPath('foo/*.ts', 'write', CWD)).toMatchObject({ verdict: 'deny', scope: 'glob' });
    expect(validateTargetPath('foo/a?.ts', 'write', CWD).verdict).toBe('deny');
  });

  test('literal bracket/brace filename → NOT rejected (no shell/glob expansion on write)', () => {
    expect(validateTargetPath('foo[1].txt', 'write', CWD).verdict).toBe('ok');
    expect(validateTargetPath('{a,b}.log', 'write', CWD).verdict).toBe('ok');
  });

  test('write escaping cwd → forced ask (../ traversal + absolute)', () => {
    expect(validateTargetPath('../../etc/passwd', 'write', CWD)).toMatchObject({ verdict: 'ask', scope: 'escape' });
    expect(validateTargetPath('/etc/x', 'write', CWD).verdict).toBe('ask');
  });

  test('write inside cwd → ok (relative + absolute)', () => {
    expect(validateTargetPath('src/a.ts', 'write', CWD).verdict).toBe('ok');
    expect(validateTargetPath('/repo/src/a.ts', 'write', CWD).verdict).toBe('ok');
    expect(validateTargetPath('/repo', 'write', CWD).verdict).toBe('ok'); // cwd itself
  });

  test('os.tmpdir() write → exempt (ok), aligning with OS sandbox temp allowance', () => {
    expect(validateTargetPath(pathJoin(tmpdir(), 'scratch.txt'), 'write', CWD).verdict).toBe('ok');
  });

  test('`$` / `~` filenames → NOT mis-rejected', () => {
    expect(validateTargetPath('/repo/$weird~name.txt', 'write', CWD).verdict).toBe('ok');
    expect(validateTargetPath('$HOME-literal.txt', 'write', CWD).verdict).toBe('ok');
    expect(validateTargetPath('~backup.txt', 'write', CWD).verdict).toBe('ok');
  });

  test('read is NOT cwd-confined (escape + glob ok for read)', () => {
    expect(validateTargetPath('/etc/passwd', 'read', CWD).verdict).toBe('ok');
    expect(validateTargetPath('../../elsewhere', 'read', CWD).verdict).toBe('ok');
    expect(validateTargetPath('foo/*.ts', 'read', CWD).verdict).toBe('ok');
  });

  test('non-existent target → no throw (realpath degrades to normalize)', () => {
    expect(() => validateTargetPath('/repo/does/not/exist/yet.txt', 'write', CWD)).not.toThrow();
    expect(validateTargetPath('/nope/definitely/missing.txt', 'write', CWD).verdict).toBe('ask');
  });
});

describe('engine integration — verdict placement', () => {
  test('deny (NUL) presses over always-allow rule', async () => {
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [{ toolName: 'write_file', behavior: 'allow' }] };
    const r = await hasPermissionsToUseTool(writeTool(), { file_path: '/repo/a\x00.ts' }, ctxCwd(CWD), rules);
    expect(r.behavior).toBe('deny');
    expect(r.decisionReason?.type).toBe('pathValidation');
  });

  test('deny (write-glob) presses over always-allow rule', async () => {
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [{ toolName: 'write_file', behavior: 'allow' }] };
    const r = await hasPermissionsToUseTool(writeTool(), { file_path: '/repo/*.ts' }, ctxCwd(CWD), rules);
    expect(r.behavior).toBe('deny');
    expect((r.decisionReason as { scope?: string }).scope).toBe('glob');
  });

  test('forced ask (cwd escape) presses over always-allow rule (allow:["Write"] can NOT suppress)', async () => {
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [{ toolName: 'write_file', behavior: 'allow' }] };
    const r = await hasPermissionsToUseTool(writeTool(), { file_path: '/etc/x' }, ctxCwd(CWD), rules);
    expect(r.behavior).toBe('ask');
    expect(r.decisionReason?.type).toBe('pathValidation');
    expect(String(r.message)).toContain('outside the working directory');
  });

  test('forced ask (cwd escape) presses over acceptEdits', async () => {
    const r = await hasPermissionsToUseTool(writeTool(), { file_path: '../escape.txt' }, ctxCwd(CWD), NO_RULES, {
      mode: 'acceptEdits',
    });
    expect(r.behavior).toBe('ask');
  });

  test('forced ask (cwd escape) is bypass-immune', async () => {
    const r = await hasPermissionsToUseTool(writeTool(), { file_path: '/etc/x' }, ctxCwd(CWD), NO_RULES, {
      mode: 'bypassPermissions',
    });
    expect(r.behavior).toBe('ask');
    expect(r.decisionReason?.type).toBe('pathValidation');
  });

  test('in-cwd write under acceptEdits → allow (no false interference)', async () => {
    const r = await hasPermissionsToUseTool(writeTool(), { file_path: '/repo/src/x.ts' }, ctxCwd(CWD), NO_RULES, {
      mode: 'acceptEdits',
    });
    expect(r.behavior).toBe('allow');
    expect((r.decisionReason as { scope?: string }).scope).toBe('in-cwd');
  });

  test('`$`/`~` filename in cwd under allow rule → allow (not mis-denied/asked)', async () => {
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [{ toolName: 'write_file', behavior: 'allow' }] };
    const r = await hasPermissionsToUseTool(writeTool(), { file_path: '/repo/$v~name.txt' }, ctxCwd(CWD), rules);
    expect(r.behavior).toBe('allow');
  });

  test('read tool escaping cwd under allow rule → allow (reads not confined)', async () => {
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [{ toolName: 'read_file', behavior: 'allow' }] };
    const r = await hasPermissionsToUseTool(readTool(), { file_path: '/etc/passwd' }, ctxCwd(CWD), rules);
    expect(r.behavior).toBe('allow');
  });

  test('non-file tool (bash) unaffected by path hardening', async () => {
    const bash = buildTool({
      name: 'bash',
      checkPermissions: async () => ({ behavior: 'allow' as const }),
      call: async (i: unknown) => ({ data: i }),
      mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [{ toolName: 'bash', behavior: 'allow' }] };
    const r = await hasPermissionsToUseTool(bash, { command: 'echo /etc/*' }, ctxCwd(CWD), rules);
    expect(r.behavior).toBe('allow');
  });
});

describe('extended protected basenames (srt list)', () => {
  test('.gitconfig / .mcp.json write → ask when safetyCheck enabled', async () => {
    const r1 = await hasPermissionsToUseTool(writeTool(), { file_path: '/repo/.gitconfig' }, ctxCwd(CWD), NO_RULES, {
      enableSafetyCheck: true,
    });
    const r2 = await hasPermissionsToUseTool(writeTool(), { file_path: '/repo/.mcp.json' }, ctxCwd(CWD), NO_RULES, {
      enableSafetyCheck: true,
    });
    expect(r1.behavior).toBe('ask');
    expect(r1.decisionReason?.type).toBe('safetyCheck');
    expect(r2.behavior).toBe('ask');
  });
});
