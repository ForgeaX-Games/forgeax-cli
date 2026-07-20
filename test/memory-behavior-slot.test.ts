import { test, expect, describe } from 'bun:test';
import { makeMemoryBehaviorSlot } from '../src/capability/memory/behavior-slot';
import { memoryPack } from '../src/capability/memory/index';
import type { SandboxFs } from '../src/inject/types';

describe('memory behavior slot', () => {
  test('static slot renders cc-style behavior instructions incl memory dir + taxonomy', () => {
    const slot = makeMemoryBehaviorSlot({ memoryDir: '/proj/.forgeax/memory' });
    expect(slot.name).toBe('memory-behavior');
    expect(slot.dynamic).toBe(false);
    const out = slot.render({});
    expect(out).toContain('/proj/.forgeax/memory'); // dir path (cache-stable)
    expect(out).toContain('user|feedback|project|reference'); // closed taxonomy
    expect(out).toContain('MEMORY.md'); // two-step how-to-save
    expect(out).toContain('Before recommending from memory'); // trusting-recall (Step8 prompt-side)
    expect(out).toContain('point-in-time'); // drift caveat
  });

  test('memoryPack mounts behavior slot + index slot (both static)', () => {
    const fakeFs = { existsSync: () => false } as unknown as SandboxFs;
    const pack = memoryPack({ memoryDir: '/m', sandboxFs: fakeFs });
    const names = (pack.slots ?? []).map((s) => s.name);
    expect(names).toContain('memory-behavior');
    expect(names).toContain('memory');
    expect((pack.slots ?? []).every((s) => s.dynamic === false)).toBe(true);
  });
});
