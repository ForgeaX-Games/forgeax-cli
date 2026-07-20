/**
 * Regression (P1) — PreToolUse hook `permissionDecision:'allow'` 不得绕过 settings
 * `deny` / `ask` 规则与受保护路径 safetyCheck。
 *
 * 曾经的缺陷:`dispatch.ts` 的 hook-allow 分支整段跳过权限把闸(`hookPerm !== 'allow'`
 * 才进闸),使一个返回 `allow` 的 hook 即便存在 deny 规则也让工具直接执行 —— deny
 * 这个 K5 最强不变量被削弱。修复:hook-allow 路径先跑规则子集 `checkRuleBasedPermissions`
 * (①deny ②ask ⑤safetyCheck):deny→拒,ask→askUser(无回调 fail-closed),null→放行(免审批卡)。
 *
 * Boundary: test 层。
 */
import { test, expect, describe } from 'bun:test';
import { dispatchTools, type ToolUse } from '../src/agent/dispatch';
import { buildTool } from '../src/capability/types';
import type { CoreEvent } from '../src/events/types';
import type { PermissionRuleSet } from '../src/permission/rules';

function okResult(o: unknown, id: string): CoreEvent {
  return { type: 'tool.result', payload: { id, o }, ts: 0 };
}

/** 记录是否真正执行的 Bash 工具。 */
function trackedTool(): { tool: ReturnType<typeof buildTool>; ran: () => boolean } {
  let ran = false;
  const tool = buildTool({
    name: 'Bash',
    call: async (i: unknown) => {
      ran = true;
      return { data: i };
    },
    mapResult: okResult,
    maxResultSizeChars: 1000,
  });
  return { tool, ran: () => ran };
}

const use: ToolUse = { id: 'a', name: 'Bash', input: {} };

describe('hook allow 不绕过 deny/ask/safetyCheck (P1)', () => {
  test('hook allow + settings deny → 拒绝,工具不执行', async () => {
    const { tool, ran } = trackedTool();
    const rules: Partial<PermissionRuleSet> = { deny: [{ toolName: 'Bash', behavior: 'deny' }] };
    const [r] = await dispatchTools([use], {
      tools: [tool],
      toolContext: {},
      signal: new AbortController().signal,
      trusted: false,
      rules,
      preToolPermission: () => 'allow',
    });
    expect(ran()).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.errorCategory).toBe('permission_denied');
  });

  test('hook allow + settings ask + 无 askUser → fail-closed 拒绝', async () => {
    const { tool, ran } = trackedTool();
    const rules: Partial<PermissionRuleSet> = { ask: [{ toolName: 'Bash', behavior: 'ask' }] };
    const [r] = await dispatchTools([use], {
      tools: [tool],
      toolContext: {},
      signal: new AbortController().signal,
      trusted: false,
      rules,
      preToolPermission: () => 'allow',
    });
    expect(ran()).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.errorCategory).toBe('permission_denied');
  });

  test('hook allow + settings ask + askUser 放行 → 执行', async () => {
    const { tool, ran } = trackedTool();
    const rules: Partial<PermissionRuleSet> = { ask: [{ toolName: 'Bash', behavior: 'ask' }] };
    const [r] = await dispatchTools([use], {
      tools: [tool],
      toolContext: {},
      signal: new AbortController().signal,
      trusted: false,
      rules,
      preToolPermission: () => 'allow',
      askUser: async () => true,
    });
    expect(ran()).toBe(true);
    expect(r.isError).toBe(false);
  });

  test('hook allow + 无反对规则 → 放行(免审批卡)', async () => {
    const { tool, ran } = trackedTool();
    const [r] = await dispatchTools([use], {
      tools: [tool],
      toolContext: {},
      signal: new AbortController().signal,
      trusted: false,
      preToolPermission: () => 'allow',
      // 注意:无 askUser。无反对规则时 hook allow 直接放行,不触发审批卡。
    });
    expect(ran()).toBe(true);
    expect(r.isError).toBe(false);
  });

  test('hook allow + safetyCheck(受保护路径 .git/)+ enableSafetyCheck → fail-closed 拒绝', async () => {
    let ran = false;
    const writeTool = buildTool({
      name: 'Write',
      call: async (i: unknown) => {
        ran = true;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 1000,
    });
    const [r] = await dispatchTools([{ id: 'w', name: 'Write', input: { file_path: '.git/config' } }], {
      tools: [writeTool],
      toolContext: {},
      signal: new AbortController().signal,
      trusted: false,
      enableSafetyCheck: true,
      preToolPermission: () => 'allow',
      // 无 askUser → safetyCheck 的 ask 落到 fail-closed deny。
    });
    expect(ran).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.errorCategory).toBe('permission_denied');
  });
});
