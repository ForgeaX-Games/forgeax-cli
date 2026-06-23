/**
 * P7 — runtime PermissionEngine.
 *
 * Spec: 03 §6 + 04 §SkillPermission. A skill (or, in a follow-up, a plugin
 * tool handler) declares the host capabilities it needs. The engine compiles
 * those declarations into a matcher and exposes `check(...)` predicates the
 * runtime calls before each capability use.
 *
 * Permission grammar (from packages/types/src/skill.ts):
 *   { kind: 'fs',    mode: 'read'|'write', path: <glob> }
 *   { kind: 'tool',  id:   <toolId> }
 *   { kind: 'net',   host: <hostname-or-glob> }
 *   { kind: 'spawn', cmd:  <command-name> }
 *
 * The string permissions form (`'fs:read:.forgeax/**'`) is also supported —
 * that's what plugin manifests use today. Each gets parsed to the structured
 * form.
 *
 * Default-deny: when permissions[] is empty, NOTHING is allowed. Skill code
 * that previously relied on the "skip if empty" loophole is intentionally
 * broken so authors notice and declare. Callers that need legacy permissive
 * behavior pass `{ legacyPermissive: true }`.
 */
import { minimatch } from 'minimatch';
import type { SkillPermission } from '@forgeax/types';

export type Permission =
  | SkillPermission
  | { kind: 'fs'; mode: 'read' | 'write'; path: string }
  | { kind: 'tool'; id: string }
  | { kind: 'net'; host: string }
  | { kind: 'spawn'; cmd: string };

export interface PermissionDecision {
  ok: boolean;
  /** When ok=false: stable code clients can match on. */
  code?: 'forbidden';
  /** When ok=false: short reason for log/UI. */
  reason?: string;
}

export interface CheckFsInput {
  mode: 'read' | 'write';
  /** Already absolute (or root-relative) path. The matcher does NOT resolve;
   *  callers must normalize beforehand. */
  path: string;
}

export interface PermissionMatcher {
  /** All compiled permissions, in original order. */
  readonly source: Permission[];
  canFs(input: CheckFsInput): PermissionDecision;
  canTool(toolId: string): PermissionDecision;
  canNet(host: string): PermissionDecision;
  canSpawn(cmd: string): PermissionDecision;
}

/** Parse `'fs:read:<glob>'` / `'tool:<id>'` / `'net:<host>'` / `'spawn:<cmd>'`
 *  into the structured form. Returns null on unrecognized strings — callers
 *  must drop those (don't silently treat as allow). */
export function parsePermissionString(s: string): Permission | null {
  const colon = s.indexOf(':');
  if (colon <= 0) return null;
  const kind = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  if (kind === 'fs') {
    const c2 = rest.indexOf(':');
    if (c2 <= 0) return null;
    const mode = rest.slice(0, c2);
    if (mode !== 'read' && mode !== 'write') return null;
    return { kind: 'fs', mode, path: rest.slice(c2 + 1) };
  }
  if (kind === 'tool') return { kind: 'tool', id: rest };
  if (kind === 'net') return { kind: 'net', host: rest };
  if (kind === 'spawn') return { kind: 'spawn', cmd: rest };
  return null;
}

/** Compile a mixed permissions list (objects + strings) into a matcher. */
export function compilePermissions(input: ReadonlyArray<Permission | string>): PermissionMatcher {
  const source: Permission[] = [];
  for (const p of input) {
    if (typeof p === 'string') {
      const parsed = parsePermissionString(p);
      if (parsed) source.push(parsed);
      // Skip silently-invalid strings rather than throwing — manifests evolve
      // and the loader already validated shapes; bad strings just don't grant
      // anything.
      continue;
    }
    source.push(p);
  }
  const fsPerms = source.filter((p): p is { kind: 'fs'; mode: 'read' | 'write'; path: string } => p.kind === 'fs');
  const toolPerms = source.filter((p): p is { kind: 'tool'; id: string } => p.kind === 'tool');
  const netPerms = source.filter((p): p is { kind: 'net'; host: string } => p.kind === 'net');
  const spawnPerms = source.filter((p): p is { kind: 'spawn'; cmd: string } => p.kind === 'spawn');

  return {
    source,
    canFs({ mode, path }) {
      for (const p of fsPerms) {
        if (p.mode !== mode && !(p.mode === 'write' && mode === 'read')) continue;
        // 'write' implies 'read' — if you can write a path you can read it.
        if (minimatch(path, p.path, { dot: true })) return { ok: true };
      }
      return { ok: false, code: 'forbidden', reason: `fs:${mode} not permitted: ${path}` };
    },
    canTool(toolId) {
      for (const p of toolPerms) {
        if (p.id === toolId || p.id === '*' || minimatch(toolId, p.id)) return { ok: true };
      }
      return { ok: false, code: 'forbidden', reason: `tool not permitted: ${toolId}` };
    },
    canNet(host) {
      for (const p of netPerms) {
        if (p.host === host || p.host === '*' || minimatch(host, p.host)) return { ok: true };
      }
      return { ok: false, code: 'forbidden', reason: `net not permitted: ${host}` };
    },
    canSpawn(cmd) {
      for (const p of spawnPerms) {
        if (p.cmd === cmd || p.cmd === '*' || minimatch(cmd, p.cmd)) return { ok: true };
      }
      return { ok: false, code: 'forbidden', reason: `spawn not permitted: ${cmd}` };
    },
  };
}
