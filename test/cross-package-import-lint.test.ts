/**
 * Doc 11 cross-package import lint - guard test that locks the package
 * boundary.
 *
 * The audit punch-list flagged the missing ESLint rule for cross-package
 * import containment. This project does not run ESLint at the monorepo root,
 * so we pin the contract with a bun:test scan instead. The rules below
 * mirror the directional graph in 13-MIGRATION-ROADMAP package-layout:
 *
 *   server      <- types only (zod schema SSOT)
 *   interface   <- @forgeax/host-sdk + HTTP; never reaches into server/* sources
 *   marketplace <- @forgeax/host-sdk + @forgeax/types; never imports server or
 *                  interface internals
 *   host-sdk    <- types only; the public seam between host and plugin
 *
 * If a future change introduces a forbidden edge, this test fails with the
 * exact file + import string so the author can either widen the public API
 * (add an export to host-sdk / types) or rewrite the call.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

interface Rule {
  /** Friendly name shown in test output. */
  scope: string;
  /** Source root being scanned, repo-relative. */
  root: string;
  /** Predicate run against each `from '<spec>'` literal. Return non-null
   *  reason to mark the import as a violation. */
  forbid(spec: string): string | null;
}

/** cli (编排层) 依赖倒置守护:forgeax-cli 只许依赖 `@forgeax/agent-runtime` + `@forgeax/types`,
 *  绝不反向 import 任何业务/内核/产品壳包。这是"编排层可独立拆出"招牌不变量的唯一测试守护。 */
function forbidCliReachIn(spec: string): string | null {
  if (spec.includes('packages/server')) return 'cli must not import server (product shell)';
  if (spec.includes('packages/marketplace')) return 'cli must not import marketplace (business plugins)';
  if (spec.includes('packages/interface')) return 'cli must not import interface';
  if (spec.includes('packages/core') || spec === '@forgeax/forgeax-core' || spec.startsWith('@forgeax/forgeax-core/'))
    return 'cli must not import forgeax-core (kernel is injected via the @forgeax/agent-runtime registry)';
  if (spec === '@forgeax/host-sdk' || spec.startsWith('@forgeax/host-sdk')) return 'cli must not depend on host-sdk (plugin-side seam)';
  return null;
}

const RULES: Rule[] = [
  {
    scope: 'cli/src',
    root: 'packages/cli/src',
    forbid: forbidCliReachIn,
  },
  {
    scope: 'cli/builtin',
    root: 'packages/cli/builtin',
    forbid: forbidCliReachIn,
  },
  {
    scope: 'server',
    root: 'packages/server/src',
    forbid: (spec) => {
      if (spec.includes('packages/interface')) return 'server must not import interface';
      if (spec.includes('packages/marketplace')) return 'server must not import marketplace plugin sources';
      if (spec.startsWith('@forgeax/host-sdk')) return 'server must not depend on host-sdk (host-sdk is the plugin-side seam)';
      return null;
    },
  },
  {
    scope: 'interface',
    root: 'packages/interface/src',
    forbid: (spec) => {
      if (spec.includes('packages/server')) return 'interface must not import server internals - go through HTTP';
      if (spec.includes('packages/marketplace')) return 'interface must not import marketplace plugin sources';
      return null;
    },
  },
  {
    scope: 'marketplace',
    root: 'packages/marketplace/extensions',
    forbid: (spec) => {
      if (spec.includes('packages/server')) return 'marketplace plugin must not import server internals';
      if (spec.includes('packages/interface')) return 'marketplace plugin must not import interface internals';
      return null;
    },
  },
  {
    scope: 'host-sdk',
    root: 'packages/host-sdk/src',
    forbid: (spec) => {
      if (spec.includes('packages/server')) return 'host-sdk must not import server';
      if (spec.includes('packages/interface')) return 'host-sdk must not import interface';
      if (spec.includes('packages/marketplace')) return 'host-sdk must not import marketplace';
      return null;
    },
  },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.vite', '__tests__', 'test']);
const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function* walk(root: string): Iterable<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const path = join(root, name);
    let s;
    try { s = statSync(path); } catch { continue; }
    if (s.isDirectory()) {
      yield* walk(path);
    } else if (s.isFile() && SOURCE_EXT.some((ext) => name.endsWith(ext))) {
      yield path;
    }
  }
}

interface Violation {
  scope: string;
  file: string;
  spec: string;
  reason: string;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import[^'"\n]*?from\s+|export[^'"\n]*?from\s+|import\s*\(\s*)['"]([^'"\n]+)['"]/g;

function scanRule(rule: Rule): Violation[] {
  const root = resolve(REPO_ROOT, rule.root);
  let exists = true;
  try { statSync(root); } catch { exists = false; }
  if (!exists) return [];
  const violations: Violation[] = [];
  for (const file of walk(root)) {
    let src: string;
    try { src = readFileSync(file, 'utf-8'); } catch { continue; }
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      const reason = rule.forbid(spec);
      if (reason) {
        violations.push({
          scope: rule.scope,
          file: file.slice(REPO_ROOT.length + 1),
          spec,
          reason,
        });
      }
    }
  }
  return violations;
}

describe('Doc 11 - cross-package import containment', () => {
  for (const rule of RULES) {
    it(`${rule.scope} obeys boundary rules`, () => {
      const violations = scanRule(rule);
      if (violations.length > 0) {
        const summary = violations
          .map((v) => `  ${v.file}\n    -> ${v.spec}\n    !! ${v.reason}`)
          .join('\n');
        throw new Error(`cross-package import violations in ${rule.scope}:\n${summary}`);
      }
      expect(violations).toHaveLength(0);
    });
  }
});
