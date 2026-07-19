/**
 * Hooks 配置读取 + 装配挂载(§4 「配置读取 / CLI / 装配」)。
 *
 * 覆盖:
 *   - readHooksSettings 两形兼容(顶层即 settings / `{hooks:{...}}` 包裹)——27.77/27.78。
 *   - getMergedSettings().hooks 从项目 settings 读出——27.79。
 *   - assembleCapabilities:给了 hooks 才订阅 bus(publish 命中 → block);
 *     没给则不挂载(publish 不受影响);disposers 解订阅——27.80/27.81。
 *
 * Boundary: test 层(可读 node:fs / 真实 host 装配)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleCapabilities } from '../src/runtime/assemble';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent } from '../src/events/types';
import { readHooksSettings } from '../src/cli/host-context';
import { getMergedSettings, resetSettingsCache } from '../src/cli/settings';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fx-hooks-'));
}
const preTool = (toolName = 'Bash'): CoreEvent => ({
  type: CoreEventType.ToolCallRequested,
  payload: { toolName, toolUseId: 't1', input: {} },
  ts: 0,
});

describe('readHooksSettings — 两形兼容', () => {
  test('顶层即 settings 形({PreToolUse:[...]})被识别', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'top.json');
      writeFileSync(p, JSON.stringify({ PreToolUse: [{ matcher: 'rm', command: 'c' }] }));
      const s = readHooksSettings(p);
      expect(s.PreToolUse).toEqual([{ matcher: 'rm', command: 'c' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('包裹形({hooks:{PreToolUse:[...]}})取 j.hooks', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'wrapped.json');
      writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [{ command: 'c2' }] }, other: 1 }));
      const s = readHooksSettings(p);
      expect(s.PreToolUse).toEqual([{ command: 'c2' }]);
      // 顶层其它键不被当 hooks(取的是 j.hooks)。
      expect((s as Record<string, unknown>).other).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getMergedSettings — 从项目 settings 读 hooks(27.79)', () => {
  test('<cwd>/.forgeax/settings.json 的 hooks 键被合并读出', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, '.forgeax'), { recursive: true });
      writeFileSync(
        join(dir, '.forgeax', 'settings.json'),
        JSON.stringify({ hooks: { Stop: [{ command: 'noop' }] } }),
      );
      // getMergedSettings 用全局缓存(忽略 cwd 入参),cwd 专属 fixture 读前须先清缓存
      // (与 permission-settings.test.ts 同约定,避免依赖测试执行顺序)。
      resetSettingsCache();
      const merged = getMergedSettings(dir) as { hooks?: Record<string, unknown> };
      expect(merged.hooks?.Stop).toEqual([{ command: 'noop' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assembleCapabilities — hooks 挂载 / 未挂载 / disposers(27.80/27.81)', () => {
  test('无 hooks:不订阅,publish 的 PreToolUse 不被拦', async () => {
    const bus = new EventBus();
    const assembled = await assembleCapabilities({ bus });
    try {
      const out = bus.publish(preTool());
      expect(out.blocked).toBeFalsy();
    } finally {
      for (const d of assembled.disposers) await d();
    }
  });

  test('有 hooks:订阅 bus(publish 命中 → block);dispose 后解除', async () => {
    const bus = new EventBus();
    let ran = 0;
    const assembled = await assembleCapabilities({
      bus,
      hooks: {
        settings: { PreToolUse: [{ command: 'c' }] },
        runHook: () => {
          ran++;
          return { block: true, reason: 'blocked-by-hook' };
        },
      },
    });
    // 挂载生效:publish 命中 → runHook 跑 + 事件被 block。
    const out = bus.publish(preTool());
    expect(ran).toBe(1);
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('blocked-by-hook');

    // disposers 里含 hook 解订阅:全 dispose 后再 publish 不再触发。
    for (const d of assembled.disposers) await d();
    const out2 = bus.publish(preTool());
    expect(ran).toBe(1); // 未再增
    expect(out2.blocked).toBeFalsy();
  });
});
