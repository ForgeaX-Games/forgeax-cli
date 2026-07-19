/**
 * H2 — settings-driven hook lifecycle 测试。
 *
 * 验证三件事:
 *  1) 每个生命周期事件名都能 alias 到正确的 CoreEventType;
 *  2) 通过 loadHooksFromSettings 订阅后,hook 会在对应事件上触发;
 *  3) HookDecision 的各字段(additionalContext/systemMessage/continue/block/modify)
 *     都被反映到 publish 回执的事件上(经真实 EventBus 跑通)。
 *
 * 直接从 from-settings.ts import(index.ts 还会再导出 protocol.ts,由 H3 提供)。
 */
import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/events/event-bus';
import type { CoreEvent } from '../src/events/types';
import { CoreEventType } from '../src/events/events';
import {
  loadHooksFromSettings,
  type HookDecision,
  type HooksSettings,
} from '../src/capability/hooks/from-settings';

function ev(type: string, payload: unknown = {}): CoreEvent {
  return { type, payload, ts: 0 };
}

/** hook 事件名 → 期望的 CoreEventType。 */
const ALIAS_EXPECT: Array<[string, string]> = [
  ['PreToolUse', CoreEventType.ToolCallRequested],
  ['PostToolUse', CoreEventType.ToolCallResult],
  ['Stop', CoreEventType.Stop],
  ['TurnStart', CoreEventType.TurnStart],
  ['TurnEnd', CoreEventType.TurnEnd],
  ['SessionStart', CoreEventType.SessionStart],
  ['SessionEnd', CoreEventType.SessionEnd],
  ['UserPromptSubmit', CoreEventType.UserPromptSubmit],
  ['PreCompact', CoreEventType.PreCompact],
  ['Notification', CoreEventType.Notification],
  ['SubagentStop', CoreEventType.SubagentStop],
];

describe('hooks lifecycle — alias resolution', () => {
  test('Stop maps to dedicated stop event (not turn.end)', () => {
    // 通过订阅后实际触发哪个 eventType 来验证 alias。
    const bus = new EventBus();
    const fired: string[] = [];
    loadHooksFromSettings(bus, { Stop: [{ command: 'noop' }] }, (_c, e) => {
      fired.push(e.type);
    });
    bus.publish(ev(CoreEventType.Stop));
    expect(fired).toEqual([CoreEventType.Stop]);
    // 不应误挂到 turn.end 上。
    fired.length = 0;
    bus.publish(ev(CoreEventType.TurnEnd));
    expect(fired).toEqual([]);
  });

  test.each(ALIAS_EXPECT)('alias %s resolves and fires on the right CoreEventType', (name, expectedType) => {
    const bus = new EventBus();
    const fired: string[] = [];
    const settings: HooksSettings = { [name]: [{ command: 'noop' }] };
    loadHooksFromSettings(bus, settings, (_c, e) => {
      fired.push(e.type);
    });
    // 在期望的 CoreEventType 上发布 → 应触发。
    bus.publish(ev(expectedType, { toolName: 'anyTool' }));
    expect(fired).toContain(expectedType);
  });
});

describe('hooks lifecycle — HookDecision fields reflected onto event', () => {
  test('additionalContext is merged onto the publish receipt', () => {
    const bus = new EventBus();
    const decision: HookDecision = { additionalContext: 'remember the goal' };
    loadHooksFromSettings(bus, { UserPromptSubmit: [{ command: 'c' }] }, () => decision);
    const out = bus.publish(ev(CoreEventType.UserPromptSubmit)) as CoreEvent & {
      additionalContext?: string;
    };
    expect(out.additionalContext).toBe('remember the goal');
  });

  test('systemMessage is merged onto the publish receipt', () => {
    const bus = new EventBus();
    const decision: HookDecision = { systemMessage: 'heads up' };
    loadHooksFromSettings(bus, { Notification: [{ command: 'c' }] }, () => decision);
    const out = bus.publish(ev(CoreEventType.Notification)) as CoreEvent & {
      systemMessage?: string;
    };
    expect(out.systemMessage).toBe('heads up');
  });

  test('continue===false sets continueLoop:false on the event', () => {
    const bus = new EventBus();
    const decision: HookDecision = { continue: false };
    loadHooksFromSettings(bus, { Stop: [{ command: 'c' }] }, () => decision);
    const out = bus.publish(ev(CoreEventType.Stop)) as CoreEvent & { continueLoop?: boolean };
    expect(out.continueLoop).toBe(false);
  });

  test('continue===true does NOT set continueLoop (only false stops the loop)', () => {
    const bus = new EventBus();
    const decision: HookDecision = { continue: true };
    loadHooksFromSettings(bus, { Stop: [{ command: 'c' }] }, () => decision);
    const out = bus.publish(ev(CoreEventType.Stop)) as CoreEvent & { continueLoop?: boolean };
    expect(out.continueLoop).toBeUndefined();
  });

  test('block sets blocked + blockReason on the event', () => {
    const bus = new EventBus();
    const decision: HookDecision = { block: true, reason: 'denied' };
    loadHooksFromSettings(
      bus,
      { PreToolUse: [{ command: 'c' }] },
      () => decision,
    );
    const out = bus.publish(ev(CoreEventType.ToolCallRequested, { toolName: 'rm' }));
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('denied');
  });

  test('modify patches the event payload-level fields', () => {
    const bus = new EventBus();
    const decision: HookDecision = { modify: { source: 'hook-rewrote' } };
    loadHooksFromSettings(bus, { TurnStart: [{ command: 'c' }] }, () => decision);
    const out = bus.publish(ev(CoreEventType.TurnStart));
    expect(out.source).toBe('hook-rewrote');
  });

  test('all structured fields can be combined on one decision', () => {
    const bus = new EventBus();
    const decision: HookDecision = {
      additionalContext: 'ctx',
      systemMessage: 'msg',
      continue: false,
      modify: { source: 's' },
    };
    loadHooksFromSettings(bus, { SubagentStop: [{ command: 'c' }] }, () => decision);
    const out = bus.publish(ev(CoreEventType.SubagentStop)) as CoreEvent & {
      additionalContext?: string;
      systemMessage?: string;
      continueLoop?: boolean;
    };
    expect(out.additionalContext).toBe('ctx');
    expect(out.systemMessage).toBe('msg');
    expect(out.continueLoop).toBe(false);
    expect(out.source).toBe('s');
  });
});

describe('hooks lifecycle — fail-soft & matcher', () => {
  test('a throwing hook never poisons the bus', () => {
    const bus = new EventBus();
    const after: string[] = [];
    loadHooksFromSettings(bus, { Notification: [{ command: 'boom' }] }, () => {
      throw new Error('hook crashed');
    });
    bus.subscribe(CoreEventType.Notification, () => void after.push('downstream'));
    const out = bus.publish(ev(CoreEventType.Notification));
    expect(out.blocked).toBeFalsy();
    expect(after).toEqual(['downstream']); // 后续订阅者仍跑
  });

  test('matcher filters tool events by toolName but always matches non-tool events', () => {
    const bus = new EventBus();
    const hits: string[] = [];
    loadHooksFromSettings(bus, { PreToolUse: [{ matcher: 'rm.*', command: 'c' }] }, (_c, e) => {
      hits.push((e.payload as { toolName?: string }).toolName ?? '<none>');
    });
    bus.publish(ev(CoreEventType.ToolCallRequested, { toolName: 'rmrf' })); // 命中
    bus.publish(ev(CoreEventType.ToolCallRequested, { toolName: 'ls' })); // 不命中
    expect(hits).toEqual(['rmrf']);

    // 非工具事件:matcher 不细分,直接命中。
    const hits2: string[] = [];
    loadHooksFromSettings(bus, { SessionStart: [{ matcher: 'whatever', command: 'c' }] }, () => {
      hits2.push('fired');
    });
    bus.publish(ev(CoreEventType.SessionStart));
    expect(hits2).toEqual(['fired']);
  });

  test('非法正则 matcher → 退化为子串 includes 匹配(不抛)', () => {
    const bus = new EventBus();
    const hits: string[] = [];
    // '[' 是非法正则 → new RegExp 抛 → catch 退化为 key.includes('[')。
    loadHooksFromSettings(bus, { PreToolUse: [{ matcher: '[', command: 'c' }] }, (_c, e) => {
      hits.push((e.payload as { toolName?: string }).toolName ?? '<none>');
    });
    bus.publish(ev(CoreEventType.ToolCallRequested, { toolName: 'a[b' })); // 含 '[' 子串 → 命中
    bus.publish(ev(CoreEventType.ToolCallRequested, { toolName: 'plain' })); // 无 '[' → 不命中
    expect(hits).toEqual(['a[b']);
  });

  test('同事件多 hook:首条 block → 后续 entry 不再跑', () => {
    const bus = new EventBus();
    const ran: string[] = [];
    loadHooksFromSettings(
      bus,
      { PreToolUse: [{ command: 'first' }, { command: 'second' }] },
      (cmd) => {
        ran.push(cmd);
        if (cmd === 'first') return { block: true, reason: 'stop here' };
        return undefined;
      },
    );
    const out = bus.publish(ev(CoreEventType.ToolCallRequested, { toolName: 'x' }));
    expect(out.blocked).toBe(true);
    expect(ran).toEqual(['first']); // second 不跑
  });

  test('unsubscribe(dispose)后 hook 不再触发', () => {
    const bus = new EventBus();
    let fires = 0;
    const dispose = loadHooksFromSettings(bus, { Notification: [{ command: 'c' }] }, () => {
      fires++;
    });
    bus.publish(ev(CoreEventType.Notification));
    expect(fires).toBe(1);
    dispose();
    bus.publish(ev(CoreEventType.Notification));
    expect(fires).toBe(1); // 解订阅后不再增
  });

  test('空数组 / 非数组 entries 跳过,不订阅、不抛', () => {
    const bus = new EventBus();
    let fired = false;
    expect(() =>
      loadHooksFromSettings(
        bus,
        { PreToolUse: [], Stop: null as never, Notification: [{ command: 'c' }] },
        () => {
          fired = true;
        },
      ),
    ).not.toThrow();
    bus.publish(ev(CoreEventType.ToolCallRequested, { toolName: 'x' })); // PreToolUse 空数组 → 无订阅
    bus.publish(ev(CoreEventType.Stop)); // Stop 非数组 → 无订阅
    expect(fired).toBe(false);
    bus.publish(ev(CoreEventType.Notification)); // 有效 entry → 触发
    expect(fired).toBe(true);
  });

  test('无 command 的 entry 被跳过', () => {
    const bus = new EventBus();
    const ran: string[] = [];
    loadHooksFromSettings(
      bus,
      { Notification: [{ matcher: 'x' } as never, { command: 'real' }] },
      (cmd) => void ran.push(cmd),
    );
    bus.publish(ev(CoreEventType.Notification));
    expect(ran).toEqual(['real']); // 无 command 的那条不跑
  });
});
