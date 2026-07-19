/**
 * T4 · TaskNotificationHub 单测(纯 HOST 层接线,core 不改)。
 *
 * 覆盖:
 *  - 观察侧①:包装 BackgroundSpawnFn,后台 bash `exit` chunk → 入队,透传全部 chunk,
 *    重复 exit 只入队一次(去重),累积有界输出尾。
 *  - 观察侧②:BackgroundTasks.onDone(成功/失败)→ 入队。
 *  - 注入侧:UserPromptSubmit publish 回执上挂 `<task_notification>` additionalContext,
 *    入队即出队(drain 后清空),追加不覆盖既有 additionalContext,空队列不改回执。
 */
import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent, HookControl } from '../src/events/types';
import { BackgroundTasks } from '../src/agent/background';
import type { SubagentResult } from '../src/agent/subagent';
import type { Chunk } from '../src/inject/types';
import type { BackgroundSpawnFn, BackgroundProcess } from '../src/capability/builtin-tools/shell-registry';
import { TaskNotificationHub } from '../src/cli/task-notification';

const NOOP_PROC: BackgroundProcess = { kill: () => {} };

/** 一个可手动喂 chunk 的假 BackgroundSpawnFn:把 onChunk 暴露给测试驱动。 */
function fakeSpawn(): { fn: BackgroundSpawnFn; emit: (c: Chunk) => void; seen: Chunk[] } {
  const seen: Chunk[] = [];
  let sink: ((c: Chunk) => void) | null = null;
  const fn: BackgroundSpawnFn = (_cmd, _args, _opts, onChunk) => {
    sink = (c: Chunk) => {
      seen.push(c);
      onChunk(c);
    };
    return NOOP_PROC;
  };
  return { fn, emit: (c) => sink?.(c), seen };
}

function upsReceipt(bus: EventBus): CoreEvent & { additionalContext?: string } {
  return bus.publish({ type: CoreEventType.UserPromptSubmit, payload: { prompt: 'hi', turn: 0 }, ts: 0 }) as CoreEvent & {
    additionalContext?: string;
  };
}

describe('TaskNotificationHub', () => {
  test('background bash exit → enqueues one notification, passes all chunks through', () => {
    const hub = new TaskNotificationHub();
    const { fn, emit, seen } = fakeSpawn();
    const passthrough: Chunk[] = [];
    const wrapped = hub.wrapBackgroundSpawn(fn);
    wrapped('sh', ['-c', 'sleep 3 && echo done'], undefined, (c) => passthrough.push(c));

    emit({ stream: 'stdout', data: 'done\n' });
    emit({ stream: 'exit', data: '0' });

    // 透传:原 onChunk 收到全部 chunk。
    expect(passthrough.map((c) => c.stream)).toEqual(['stdout', 'exit']);
    expect(seen.length).toBe(2);
    // 入队一条,label = 命令末段,status = exit code,尾含 stdout。
    expect(hub.size).toBe(1);
  });

  test('duplicate exit chunk only enqueues once (dedup)', () => {
    const hub = new TaskNotificationHub();
    const { fn, emit } = fakeSpawn();
    const wrapped = hub.wrapBackgroundSpawn(fn);
    wrapped('sh', ['-c', 'x'], undefined, () => {});
    emit({ stream: 'exit', data: '0' });
    emit({ stream: 'exit', data: '0' });
    expect(hub.size).toBe(1);
  });

  test('UserPromptSubmit drains queue into <task_notification> additionalContext', () => {
    const hub = new TaskNotificationHub();
    const bus = new EventBus();
    hub.subscribe(bus);
    hub.enqueue({ label: 'sleep 3 && echo done', status: 'exit code 0', outputTail: 'done' });

    const receipt = upsReceipt(bus);
    expect(receipt.additionalContext).toContain('<task_notification>');
    expect(receipt.additionalContext).toContain('sleep 3 && echo done');
    expect(receipt.additionalContext).toContain('exit code 0');
    expect(receipt.additionalContext).toContain('done');
    // 入队即出队:drain 后清空,下一次不再注入。
    expect(hub.size).toBe(0);
    const receipt2 = upsReceipt(bus);
    expect(receipt2.additionalContext).toBeUndefined();
  });

  test('multiple concurrent completions merge into one block, in order', () => {
    const hub = new TaskNotificationHub();
    const bus = new EventBus();
    hub.subscribe(bus);
    hub.enqueue({ label: 'task-a', status: 'exit code 0' });
    hub.enqueue({ label: 'task-b', status: 'exit code 1' });
    const receipt = upsReceipt(bus);
    const ctx = receipt.additionalContext ?? '';
    // 单个 <task_notification> 块,两条按序。
    expect(ctx.match(/<task_notification>/g)?.length).toBe(1);
    expect(ctx.indexOf('task-a')).toBeLessThan(ctx.indexOf('task-b'));
  });

  test('appends to (does not clobber) an existing additionalContext on the receipt', () => {
    const hub = new TaskNotificationHub();
    const bus = new EventBus();
    // 前置订阅者(模拟 settings hook)先挂 additionalContext。
    bus.subscribe(CoreEventType.UserPromptSubmit, (_e: CoreEvent, ctl: HookControl) => {
      ctl.modify({ additionalContext: 'PRIOR-HOOK-CTX' } as Partial<CoreEvent>);
    });
    hub.subscribe(bus);
    hub.enqueue({ label: 'task-x', status: 'exit code 0' });
    const receipt = upsReceipt(bus);
    const ctx = receipt.additionalContext ?? '';
    expect(ctx).toContain('PRIOR-HOOK-CTX');
    expect(ctx).toContain('<task_notification>');
    expect(ctx.indexOf('PRIOR-HOOK-CTX')).toBeLessThan(ctx.indexOf('<task_notification>'));
  });

  test('empty queue leaves the receipt untouched', () => {
    const hub = new TaskNotificationHub();
    const bus = new EventBus();
    hub.subscribe(bus);
    const receipt = upsReceipt(bus);
    expect(receipt.additionalContext).toBeUndefined();
  });

  test('subagent onDone (success + failure) enqueues notifications', () => {
    const hub = new TaskNotificationHub();
    const bg = new BackgroundTasks<SubagentResult>({ onDone: hub.onSubagentDone });
    // 成功:result 携 text/terminalReason。
    bg.start(
      'explore',
      Promise.resolve({ agentId: 'explore', text: 'found it', terminalReason: 'completed', turns: 2, toolCalls: 1 }),
    );
    // 失败:reject。
    bg.start('build', Promise.reject(new Error('boom')));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(hub.size).toBe(2);
        const bus = new EventBus();
        hub.subscribe(bus);
        const ctx = upsReceipt(bus).additionalContext ?? '';
        expect(ctx).toContain('explore');
        expect(ctx).toContain('found it');
        expect(ctx).toContain('build');
        expect(ctx).toContain('failed: boom');
        resolve();
      }, 10);
    });
  });
});

// ── T4.5:活动接缝(setActivityListener)+ 主动 drain + 运行计数 ──
describe('TaskNotificationHub · T4.5 activity seam', () => {
  test('enqueue fires the activity listener with the completed item; unregister stops it', () => {
    const hub = new TaskNotificationHub();
    const completions: string[] = [];
    hub.setActivityListener((c) => {
      if (c) completions.push(c.label);
    });
    hub.enqueue({ label: 'a', status: 'exit code 0' });
    hub.enqueue({ label: 'b', status: 'exit code 1' });
    expect(completions).toEqual(['a', 'b']);
    hub.setActivityListener(undefined);
    hub.enqueue({ label: 'c', status: 'exit code 0' });
    expect(completions).toEqual(['a', 'b']); // 注销后不再回调
    expect(hub.size).toBe(3); // 但入队不受影响
  });

  test('a throwing activity listener never breaks enqueue (fail-soft)', () => {
    const hub = new TaskNotificationHub();
    hub.setActivityListener(() => {
      throw new Error('listener boom');
    });
    expect(() => hub.enqueue({ label: 'a', status: 'exit code 0' })).not.toThrow();
    expect(hub.size).toBe(1);
  });

  test('runningShells counts spawn→exit; count-change notifies without an item', () => {
    const hub = new TaskNotificationHub();
    const events: Array<string | undefined> = [];
    hub.setActivityListener((c) => events.push(c?.label));
    const { fn, emit } = fakeSpawn();
    const wrapped = hub.wrapBackgroundSpawn(fn);
    expect(hub.runningShells).toBe(0);
    wrapped('sh', ['-c', 'sleep 1'], undefined, () => {});
    expect(hub.runningShells).toBe(1); // spawn 即 +1
    expect(events).toEqual([undefined]); // 起跑上报:不带完成项
    emit({ stream: 'exit', data: '0' });
    expect(hub.runningShells).toBe(0); // exit 即 -1
    expect(events).toEqual([undefined, 'sleep 1']); // 完成上报:带完成项
    emit({ stream: 'exit', data: '0' }); // 重复 exit:去重,不再变化
    expect(hub.runningShells).toBe(0);
    expect(events.length).toBe(2);
  });

  test('runningAgents counts start→settle; start notifies without an item', async () => {
    const hub = new TaskNotificationHub();
    const events: Array<string | undefined> = [];
    hub.setActivityListener((c) => events.push(c?.label));
    const bg = new BackgroundTasks<SubagentResult>({ onStart: hub.onSubagentStart, onDone: hub.onSubagentDone });
    expect(hub.runningAgents).toBe(0);
    let done!: (r: SubagentResult) => void;
    bg.start('explore', new Promise<SubagentResult>((r) => (done = r)));
    expect(hub.runningAgents).toBe(1); // 登记即 +1
    expect(events).toEqual([undefined]); // 起跑上报:不带完成项
    bg.start('build', Promise.reject(new Error('boom')));
    expect(hub.runningAgents).toBe(2);
    done({ agentId: 'explore', text: 'ok', terminalReason: 'completed', turns: 1, toolCalls: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.runningAgents).toBe(0); // 成功/失败 settle 都 -1
    expect(events).toEqual([undefined, undefined, 'build', 'explore']); // 完成上报:带完成项(settle 序)
  });

  test('drain empties pending; UserPromptSubmit afterwards injects nothing (no double delivery)', () => {
    const hub = new TaskNotificationHub();
    hub.enqueue({ label: 'x', status: 'exit code 0', outputTail: 'tail' });
    hub.enqueue({ label: 'y', status: 'exit code 2' });
    const items = hub.drain();
    expect(items.map((i) => i.label)).toEqual(['x', 'y']);
    expect(hub.size).toBe(0);
    expect(hub.drain()).toEqual([]); // 幂等:再 drain 得空
    const bus = new EventBus();
    hub.subscribe(bus);
    expect(upsReceipt(bus).additionalContext).toBeUndefined(); // T4 注入侧不双投
  });
});
