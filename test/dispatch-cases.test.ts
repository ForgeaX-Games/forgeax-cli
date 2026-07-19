/**
 * dispatch-cases — coverage-completion suite for `src/agent/dispatch.ts`.
 *
 * Targets the previously-uncovered runOne / partition / dispatchTools branches:
 *  - unknown tool → error result                              (dispatch.ts:60-61)
 *  - isBlocked hook intercept → "blocked by hook" error       (dispatch.ts:63-64)
 *  - inputSchema validation failure → fail-fast before hook/permission/call
 *  - permission deny → error result, call NOT run             (dispatch.ts:74-81)
 *  - tool.call throws → mapped to error result                (dispatch.ts:88-93)
 *  - parallel batch: ≥2 concurrency-safe tools via Promise.all (dispatch.ts:131-132)
 *  - isConcurrencySafe throws → fail-closed serial            (dispatch.ts:109)
 *  - abort short-circuits remaining batches                   (dispatch.ts:128)
 *  - alias resolution + updatedInput from permission allow
 *
 * Covers: partitionToolCalls + toolExecution.ts.
 */
import { test, expect, describe } from 'bun:test';
import { dispatchTools, partition, type ToolUse } from '../src/agent/dispatch';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { CoreEvent } from '../src/events/types';
import type { PermissionRuleSet } from '../src/permission/rules';

function okResult(o: unknown, id: string): CoreEvent {
  return { type: 'tool.result', payload: { id, o }, ts: 0 };
}

function deps(tools: AgentTool[], over: Partial<Parameters<typeof dispatchTools>[1]> = {}) {
  return {
    tools,
    toolContext: {},
    signal: new AbortController().signal,
    trusted: false,
    ...over,
  };
}

// concurrency-safe read tool
const safeTool = buildTool({
  name: 'safe',
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: okResult,
  maxResultSizeChars: 1000,
});

// not-concurrency-safe (serial) tool (buildTool default isConcurrencySafe=false)
const serialTool = buildTool({
  name: 'serial',
  call: async (i: unknown) => ({ data: i }),
  mapResult: okResult,
  maxResultSizeChars: 1000,
});

// ─── unknown tool ─────────────────────────────────────────────────────────────

describe('dispatch — unknown tool', () => {
  test('unknown tool name → isError result with message', async () => {
    const results = await dispatchTools([{ id: 'x', name: 'ghost', input: {} }], deps([safeTool], { trusted: true }));
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toContain('unknown tool');
  });
});

// ─── hook isBlocked ───────────────────────────────────────────────────────────

describe('dispatch — hook isBlocked intercept', () => {
  test('isBlocked returns true → "blocked by hook" error, call NOT run', async () => {
    let ran = false;
    const tool = buildTool({
      name: 'blockme',
      call: async () => {
        ran = true;
        return { data: 1 };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'b', name: 'blockme', input: {} }], deps([tool], {
      isBlocked: () => true,
    }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toContain('blocked by hook');
    expect(ran).toBe(false);
  });

  test('isBlocked returns false → tool runs normally', async () => {
    const results = await dispatchTools([{ id: 'b', name: 'serial', input: { v: 1 } }], deps([serialTool], {
      isBlocked: () => false,
    }));
    expect(results[0].isError).toBe(false);
  });
});

// ─── 通用 schema + 工具专属语义校验 ─────────────────────────────────────────

describe('dispatch — generic input validation', () => {
  test('inputSchema.safeParse failure → validation error before hook/permission/call', async () => {
    const visited: string[] = [];
    const schemaError = Object.assign(new Error('expected number'), {
      issues: [{ path: ['n'], message: 'expected number' }],
    });
    const tool = buildTool<{ n: number }, unknown>({
      name: 'schema',
      inputSchema: {
        parse: () => { throw schemaError; },
        safeParse: () => ({ success: false, error: schemaError }),
      },
      checkPermissions: async () => {
        visited.push('permission');
        return { behavior: 'allow' };
      },
      call: async (i) => {
        visited.push('call');
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 's', name: 'schema', input: { n: 'x' } }], deps([tool], {
      trusted: true,
      isBlocked: () => { visited.push('hook'); return false; },
    }));
    expect(results[0]).toMatchObject({ isError: true, errorCategory: 'validation', validationPath: '$.n' });
    expect((results[0].result.payload as { message: string }).message).toContain('InputValidationError');
    expect(visited).toEqual([]);
  });

  test('legacy safeParse success without data falls back to parse', async () => {
    const seen: unknown[] = [];
    const tool = buildTool<{ n: number }, unknown>({
      name: 'legacy-schema',
      inputSchema: {
        parse: (x: unknown) => ({ n: Number((x as { n: string }).n) }),
        safeParse: () => ({ success: true }) as { success: true; data: { n: number } },
      },
      checkPermissions: async (input) => { seen.push(['permission', input]); return { behavior: 'allow' }; },
      call: async (input) => { seen.push(['call', input]); return { data: input }; },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const hookInputs: unknown[] = [];
    const [result] = await dispatchTools([{ id: 'legacy', name: tool.name, input: { n: '3' } }], deps([tool], {
      isBlocked: (use) => { hookInputs.push(use.input); return false; },
      preToolPermission: (use) => { hookInputs.push(use.input); return undefined; },
    }));
    expect(result.isError).toBe(false);
    expect(hookInputs).toEqual([{ n: 3 }, { n: 3 }]);
    expect(seen).toEqual([
      ['permission', { n: 3 }],
      ['call', { n: 3 }],
    ]);
  });

  test('safeParse transformed data reaches validateInput, permission, and call', async () => {
    const seen: unknown[] = [];
    const tool = buildTool<{ n: number }, unknown>({
      name: 'okschema',
      inputSchema: {
        parse: (x: unknown) => ({ n: Number((x as { n: string }).n) }),
        safeParse: (x: unknown) => ({ success: true, data: { n: Number((x as { n: string }).n) } }),
      },
      validateInput: async (input) => { seen.push(['validate', input]); return { result: true }; },
      checkPermissions: async (input) => { seen.push(['permission', input]); return { behavior: 'allow', updatedInput: input }; },
      call: async (input) => { seen.push(['call', input]); return { data: input }; },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const hookInputs: unknown[] = [];
    const results = await dispatchTools([{ id: 'o', name: 'okschema', input: { n: '3' } }], deps([tool], {
      isBlocked: (use) => { hookInputs.push(use.input); return false; },
      preToolPermission: (use) => { hookInputs.push(use.input); return undefined; },
    }));
    expect(results[0].isError).toBe(false);
    expect(hookInputs).toEqual([{ n: 3 }, { n: 3 }]);
    expect(seen).toEqual([
      ['validate', { n: 3 }],
      ['permission', { n: 3 }],
      ['call', { n: 3 }],
    ]);
  });

  test('validateInput false/throw → validation error and call never runs, including trusted channel', async () => {
    for (const mode of ['false', 'throw'] as const) {
      let ran = false;
      const tool = buildTool({
        name: `semantic-${mode}`,
        validateInput: async () => {
          if (mode === 'throw') throw new Error('semantic exploded');
          return { result: false as const, message: 'semantic rejected', errorCode: 7 };
        },
        call: async () => { ran = true; return { data: null }; },
        mapResult: okResult,
        maxResultSizeChars: 100,
      });
      const [result] = await dispatchTools([{ id: mode, name: tool.name, input: {} }], deps([tool], { trusted: true }));
      expect(result.errorCategory).toBe('validation');
      expect(result.validationPath).toBe('$');
      if (mode === 'false') expect(result.validationCode).toBe(7);
      expect(ran).toBe(false);
    }
  });

  test('invalid schema input is partitioned conservatively', () => {
    const tool = buildTool<{ n: number }, unknown>({
      name: 'schema-safe',
      inputSchema: {
        parse: (x: unknown) => x as { n: number },
        safeParse: () => ({ success: false }),
      },
      isConcurrencySafe: () => true,
      call: async (input) => ({ data: input }),
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    expect(partition([
      { id: '1', name: 'safe', input: {} },
      { id: '2', name: 'schema-safe', input: {} },
      { id: '3', name: 'safe', input: {} },
    ], [safeTool, tool]).map((batch) => batch.map((use) => use.id))).toEqual([['1'], ['2'], ['3']]);
  });
});

// ─── permission deny ──────────────────────────────────────────────────────────

describe('dispatch — permission deny', () => {
  test('checkPermissions deny → error result, call NOT run', async () => {
    let ran = false;
    const tool = buildTool({
      name: 'danger',
      checkPermissions: async () => ({ behavior: 'deny', message: 'no way' }),
      call: async () => {
        ran = true;
        return { data: 1 };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'd', name: 'danger', input: {} }], deps([tool]));
    expect(results[0].isError).toBe(true);
    expect(ran).toBe(false);
  });

  test('deny rule (settings) → error result', async () => {
    const rules: Partial<PermissionRuleSet> = { deny: [{ toolName: 'serial', behavior: 'deny' }] };
    const results = await dispatchTools([{ id: 'r', name: 'serial', input: {} }], deps([serialTool], { rules }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toContain('denied');
  });

  test('trusted channel bypasses permission deny entirely', async () => {
    let ran = false;
    const tool = buildTool({
      name: 'danger2',
      checkPermissions: async () => ({ behavior: 'deny', message: 'no' }),
      call: async () => {
        ran = true;
        return { data: 'ok' };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'd', name: 'danger2', input: {} }], deps([tool], { trusted: true }));
    expect(results[0].isError).toBe(false);
    expect(ran).toBe(true);
  });

  test('permission allow updatedInput is passed to call', async () => {
    let seen: unknown;
    const tool = buildTool({
      name: 'rewrite',
      checkPermissions: async () => ({ behavior: 'allow', updatedInput: { rewritten: true } }),
      call: async (i) => {
        seen = i;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    await dispatchTools([{ id: 'w', name: 'rewrite', input: { rewritten: false } }], deps([tool]));
    expect(seen).toEqual({ rewritten: true });
  });
});

// ─── tool.call throws ─────────────────────────────────────────────────────────

describe('dispatch — tool.call throws', () => {
  test('Error thrown in call → mapped to isError result with message', async () => {
    const tool = buildTool({
      name: 'boom',
      call: async () => {
        throw new Error('kaboom');
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'e', name: 'boom', input: {} }], deps([tool], { trusted: true }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toBe('kaboom');
  });

  test('non-Error thrown (string) → stringified message', async () => {
    const tool = buildTool({
      name: 'boom2',
      call: async () => {
        throw 'plain-string-error';
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'e', name: 'boom2', input: {} }], deps([tool], { trusted: true }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toBe('plain-string-error');
  });
});

// ─── parallel batch (Promise.all) ─────────────────────────────────────────────

describe('dispatch — parallel batch of concurrency-safe tools', () => {
  test('≥2 consecutive safe tools run as one Promise.all batch, results in order', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const par = buildTool({
      name: 'par',
      isConcurrencySafe: () => true,
      call: async (i: unknown) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push((i as { id: string }).id);
        active--;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const uses: ToolUse[] = [
      { id: 'a', name: 'par', input: { id: 'a' } },
      { id: 'b', name: 'par', input: { id: 'b' } },
      { id: 'c', name: 'par', input: { id: 'c' } },
    ];
    const results = await dispatchTools(uses, deps([par], { trusted: true }));
    // ran concurrently (Promise.all) → more than 1 active at once
    expect(maxActive).toBeGreaterThan(1);
    // output preserves original ordering of uses
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'b', 'c']);
  });
});

// ─── isConcurrencySafe throws → fail-closed serial ───────────────────────────

describe('partition — isConcurrencySafe throws → fail-closed (serial)', () => {
  test('throwing predicate is treated as unsafe → its own serial batch', () => {
    const blowup = buildTool({
      name: 'blowup',
      isConcurrencySafe: () => {
        throw new Error('predicate failed');
      },
      call: async () => ({ data: 1 }),
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const uses: ToolUse[] = [
      { id: '1', name: 'safe', input: {} },
      { id: '2', name: 'blowup', input: {} },
      { id: '3', name: 'safe', input: {} },
    ];
    const batches = partition(uses, [safeTool, blowup]);
    // safe | blowup(serial) | safe → 3 batches
    expect(batches.map((b) => b.map((u) => u.id))).toEqual([['1'], ['2'], ['3']]);
  });

  test('unknown tool in partition → treated as unsafe (its own batch)', () => {
    const uses: ToolUse[] = [
      { id: '1', name: 'safe', input: {} },
      { id: '2', name: 'ghost', input: {} },
    ];
    const batches = partition(uses, [safeTool]);
    expect(batches.map((b) => b.map((u) => u.id))).toEqual([['1'], ['2']]);
  });

  test('end-of-list trailing safe batch flushed', () => {
    const uses: ToolUse[] = [
      { id: '1', name: 'serial', input: {} },
      { id: '2', name: 'safe', input: {} },
      { id: '3', name: 'safe', input: {} },
    ];
    const batches = partition(uses, [serialTool, safeTool]);
    expect(batches.map((b) => b.map((u) => u.id))).toEqual([['1'], ['2', '3']]);
  });
});

// ─── abort short-circuits remaining batches ──────────────────────────────────

describe('dispatch — abort short-circuits remaining batches', () => {
  test('pre-aborted signal → no batches run, empty results', async () => {
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    const tool = buildTool({
      name: 'serial',
      call: async () => {
        ran = true;
        return { data: 1 };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: '1', name: 'serial', input: {} }], deps([tool], { signal: ac.signal, trusted: true }));
    expect(results).toHaveLength(0);
    expect(ran).toBe(false);
  });

  test('abort after first serial batch → remaining batches skipped', async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const tool = buildTool({
      name: 'serial',
      call: async (i: unknown) => {
        const id = (i as { id: string }).id;
        ran.push(id);
        if (id === '1') ac.abort('after-first');
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const uses: ToolUse[] = [
      { id: '1', name: 'serial', input: { id: '1' } },
      { id: '2', name: 'serial', input: { id: '2' } },
    ];
    const results = await dispatchTools(uses, deps([tool], { signal: ac.signal, trusted: true }));
    expect(ran).toEqual(['1']); // second batch short-circuited
    expect(results.map((r) => r.toolUseId)).toEqual(['1']);
  });
});

// ─── JSON-schema coercion + validation (P1) ──────────────────────────────────

describe('dispatch — schema-driven coercion before validation', () => {
  function schemaTool(seen: { v?: unknown }) {
    return buildTool({
      name: 'params',
      // 声明式工具(有 inputJSONSchema,无 zod parser)→ 走 coerce + walker。
      inputJSONSchema: {
        type: 'object',
        properties: {
          head_limit: { type: 'number' },
          '-i': { type: 'boolean' },
          pattern: { type: 'string' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      call: async (i: unknown) => {
        seen.v = i;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
  }

  test('quoted number/boolean coerced → validation passes, call sees real types', async () => {
    const seen: { v?: unknown } = {};
    const results = await dispatchTools(
      [{ id: 'p', name: 'params', input: { pattern: 'x', head_limit: '30', '-i': 'true' } }],
      deps([schemaTool(seen)], { trusted: true }),
    );
    expect(results[0].isError).toBe(false);
    expect(seen.v).toEqual({ pattern: 'x', head_limit: 30, '-i': true });
  });

  test('illegal literal still rejected by walker (not silently swallowed)', async () => {
    const seen: { v?: unknown } = {};
    const results = await dispatchTools(
      [{ id: 'p', name: 'params', input: { pattern: 'x', head_limit: 'abc' } }],
      deps([schemaTool(seen)], { trusted: true }),
    );
    expect(results[0].isError).toBe(true);
    expect(results[0].errorCategory).toBe('validation');
    expect(seen.v).toBeUndefined(); // call never ran
  });

  test('empty-string number rejected (cc restraint: no z.coerce swallow)', async () => {
    const seen: { v?: unknown } = {};
    const results = await dispatchTools(
      [{ id: 'p', name: 'params', input: { pattern: 'x', head_limit: '' } }],
      deps([schemaTool(seen)], { trusted: true }),
    );
    expect(results[0].isError).toBe(true);
    expect(seen.v).toBeUndefined();
  });

  test('legit typed inputs pass through unchanged (no regression)', async () => {
    const seen: { v?: unknown } = {};
    const results = await dispatchTools(
      [{ id: 'p', name: 'params', input: { pattern: 'x', head_limit: 5, '-i': false } }],
      deps([schemaTool(seen)], { trusted: true }),
    );
    expect(results[0].isError).toBe(false);
    expect(seen.v).toEqual({ pattern: 'x', head_limit: 5, '-i': false });
  });
});

// ─── alias resolution ─────────────────────────────────────────────────────────

describe('dispatch — alias resolution', () => {
  test('tool resolved by alias name', async () => {
    const aliased = buildTool({
      name: 'canonical',
      aliases: ['old_name'],
      call: async (i: unknown) => ({ data: i }),
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'a', name: 'old_name', input: { v: 1 } }], deps([aliased], { trusted: true }));
    expect(results[0].isError).toBe(false);
    expect(results[0].toolName).toBe('old_name');
  });
});
