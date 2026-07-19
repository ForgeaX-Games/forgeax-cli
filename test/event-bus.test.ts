import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/events/event-bus';
import type { CoreEvent } from '../src/events/types';
import { InMemoryEventStore, connectStore } from '../src/history/event-store';

function ev(type: string, payload: unknown = {}): CoreEvent {
  return { type, payload, ts: 0 };
}

describe('EventBus', () => {
  test('publish is synchronous and runs subscribers in registration order', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe('*', () => void order.push('a'));
    bus.subscribe('*', () => void order.push('b'));
    bus.publish(ev('x'));
    expect(order).toEqual(['a', 'b']);
  });

  test('filter matches by exact type, "*", and predicate', () => {
    const bus = new EventBus();
    const hits: string[] = [];
    bus.subscribe('foo', () => void hits.push('exact'));
    bus.subscribe('*', () => void hits.push('all'));
    bus.subscribe((e) => e.type.startsWith('f'), () => void hits.push('pred'));
    bus.publish(ev('foo'));
    expect(hits.sort()).toEqual(['all', 'exact', 'pred']);
    hits.length = 0;
    bus.publish(ev('bar'));
    expect(hits).toEqual(['all']);
  });

  test('subscribe/unsubscribe during dispatch is safe (snapshot); no infinite loop, no skip', () => {
    const bus = new EventBus();
    const order: string[] = [];
    // 首个订阅者在 dispatch 内部再 subscribe(新增者本轮不应跑)+ 移除自己(本轮仍跑)。
    const off = bus.subscribe('*', () => {
      order.push('first');
      bus.subscribe('*', () => void order.push('added-during-dispatch'));
      off(); // 移除自身
    });
    bus.subscribe('*', () => void order.push('second'));
    bus.publish(ev('x'));
    // 本轮用 [...subs] 快照:只有注册时已在册的 first + second 跑;新增者不跑。
    expect(order).toEqual(['first', 'second']);
    // 下一轮:first 已被移除,added-during-dispatch 现在在册。
    order.length = 0;
    bus.publish(ev('x'));
    expect(order).toEqual(['second', 'added-during-dispatch']);
  });

  test('modify chains: later subscribers see the patched event', () => {
    const bus = new EventBus();
    let seen: unknown;
    bus.subscribe('*', (_e, ctl) => ctl.modify({ payload: { v: 1 } }));
    bus.subscribe('*', (e) => void (seen = e.payload));
    const out = bus.publish(ev('x'));
    expect(seen).toEqual({ v: 1 });
    expect(out.payload).toEqual({ v: 1 });
  });

  test('handler returning an event is treated as modify', () => {
    const bus = new EventBus();
    let seen: unknown;
    bus.subscribe('*', (e) => ({ ...e, payload: { patched: true } }));
    bus.subscribe('*', (e) => void (seen = e.payload));
    bus.publish(ev('x'));
    expect(seen).toEqual({ patched: true });
  });

  test('block terminates propagation; later subscribers do not run', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe('*', (_e, ctl) => {
      order.push('first');
      ctl.block('nope');
    });
    bus.subscribe('*', () => void order.push('second'));
    const out = bus.publish(ev('x'));
    expect(order).toEqual(['first']);
    expect(out.blocked).toBe(true);
    expect(out.blockReason).toBe('nope');
  });

  test('a throwing subscriber is swallowed and does not stop the chain', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe('*', () => {
      throw new Error('boom');
    });
    bus.subscribe('*', () => void order.push('after'));
    expect(() => bus.publish(ev('x'))).not.toThrow();
    expect(order).toEqual(['after']);
  });
});

describe('connectStore (§6.3 blocked events do not enter the store)', () => {
  test('non-blocked events are appended in order', async () => {
    const bus = new EventBus();
    const store = new InMemoryEventStore();
    connectStore(bus, store);
    bus.publish(ev('a'));
    bus.publish(ev('b'));
    await Promise.resolve();
    expect(store.snapshot().map((e) => e.type)).toEqual(['a', 'b']);
  });

  test('a hook registered before the store-append blocks persistence', async () => {
    const bus = new EventBus();
    const store = new InMemoryEventStore();
    bus.subscribe('drop', (_e, ctl) => ctl.block());
    connectStore(bus, store); // registered LAST
    bus.publish(ev('keep'));
    bus.publish(ev('drop'));
    await Promise.resolve();
    expect(store.snapshot().map((e) => e.type)).toEqual(['keep']);
  });
});
