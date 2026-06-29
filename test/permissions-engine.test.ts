/**
 * P7 — PermissionEngine unit tests. Verifies the parse/compile pair and each
 * capability matcher for the cases the runtime depends on:
 *   - default-deny when nothing is declared
 *   - glob match for fs paths
 *   - 'write' implies 'read' (a long-standing UNIX-ism we preserve here)
 *   - tool/net/spawn equality + glob support
 */
import { describe, it, expect } from 'bun:test';
import { compilePermissions, parsePermissionString } from '../src/permissions/engine';

describe('parsePermissionString', () => {
  it('parses fs:read:<glob>', () => {
    expect(parsePermissionString('fs:read:.forgeax/**')).toEqual({
      kind: 'fs',
      mode: 'read',
      path: '.forgeax/**',
    });
  });
  it('parses fs:write:<glob>', () => {
    expect(parsePermissionString('fs:write:tmp/**')).toEqual({
      kind: 'fs',
      mode: 'write',
      path: 'tmp/**',
    });
  });
  it('rejects fs:other:<...> (only read|write allowed)', () => {
    expect(parsePermissionString('fs:exec:foo')).toBeNull();
  });
  it('parses tool:<id>, net:<host>, spawn:<cmd>', () => {
    expect(parsePermissionString('tool:wb-character.generate')).toEqual({
      kind: 'tool',
      id: 'wb-character.generate',
    });
    expect(parsePermissionString('net:api.openai.com')).toEqual({
      kind: 'net',
      host: 'api.openai.com',
    });
    expect(parsePermissionString('spawn:git')).toEqual({ kind: 'spawn', cmd: 'git' });
  });
  it('returns null for malformed input', () => {
    expect(parsePermissionString('bare')).toBeNull();
    expect(parsePermissionString(':oops')).toBeNull();
    expect(parsePermissionString('xx:yy')).toBeNull();
  });
});

describe('PermissionMatcher.canFs', () => {
  it('default-denies when no fs permissions declared', () => {
    const m = compilePermissions([]);
    expect(m.canFs({ mode: 'read', path: '/anywhere' }).ok).toBe(false);
  });
  it('matches a glob with read mode', () => {
    const m = compilePermissions(['fs:read:/tmp/**']);
    expect(m.canFs({ mode: 'read', path: '/tmp/foo/bar.txt' }).ok).toBe(true);
    expect(m.canFs({ mode: 'read', path: '/etc/passwd' }).ok).toBe(false);
  });
  it('write implies read', () => {
    const m = compilePermissions(['fs:write:/data/**']);
    expect(m.canFs({ mode: 'write', path: '/data/x' }).ok).toBe(true);
    expect(m.canFs({ mode: 'read', path: '/data/x' }).ok).toBe(true);
  });
  it('but read does NOT imply write', () => {
    const m = compilePermissions(['fs:read:/etc/**']);
    expect(m.canFs({ mode: 'write', path: '/etc/foo' }).ok).toBe(false);
  });
});

describe('PermissionMatcher.canTool / canNet / canSpawn', () => {
  it('canTool exact + wildcard', () => {
    const m = compilePermissions([{ kind: 'tool', id: 'wb-character.generate' }, 'tool:fs.*']);
    expect(m.canTool('wb-character.generate').ok).toBe(true);
    expect(m.canTool('fs.read').ok).toBe(true);
    expect(m.canTool('mystery.x').ok).toBe(false);
  });
  it('canNet glob', () => {
    const m = compilePermissions(['net:*.openai.com']);
    expect(m.canNet('api.openai.com').ok).toBe(true);
    expect(m.canNet('evil.com').ok).toBe(false);
  });
  it('canSpawn star permits everything', () => {
    const m = compilePermissions([{ kind: 'spawn', cmd: '*' }]);
    expect(m.canSpawn('rm').ok).toBe(true);
    expect(m.canSpawn('git').ok).toBe(true);
  });
  it('default-denies for unknown kinds', () => {
    const m = compilePermissions([]);
    expect(m.canTool('any').ok).toBe(false);
    expect(m.canNet('host').ok).toBe(false);
    expect(m.canSpawn('cmd').ok).toBe(false);
  });
});
