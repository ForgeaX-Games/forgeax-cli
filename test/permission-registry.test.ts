import { describe, test, expect } from 'bun:test';
import {
  registerPermission,
  resolvePermission,
  denyPermissionsForSession,
} from '../src/core/permission-registry';

// 权限审批卡的生命周期必须跟 turn 绑死。曾经的问题:turn 被新消息/取消打断(子进程
// 被终止、其 MCP permission 子进程一并被杀、HTTP 断开)后,registry 里挂起的
// permission 不会自动 resolve,要等 10min 超时;前端卡也只在 `permission:resolved`
// 才清 → 卡杵在界面上对一个已死的 turn 作答。修法是给每个 reqId 记 owner(sid+agent),
// turn 收尾时 denyPermissionsForSession 把它名下的 pending 全部 fail-closed resolve
// 掉(随后 /permission-request 的 finally 发 permission:resolved → 卡消失)。
// 这组用例锁三道闸门。

describe('permission-registry denyPermissionsForSession()', () => {
  test('releases (deny) every pending owned by the session, immediately', async () => {
    const a = registerPermission('p-a', 60_000, { sid: 's1', agent: 'forge' });
    const b = registerPermission('p-b', 60_000, { sid: 's1', agent: 'forge' });

    const released = denyPermissionsForSession('s1');
    expect(released.sort()).toEqual(['p-a', 'p-b']);
    // fail closed — never retroactively allow a turn we can't drive.
    expect(await a.promise).toBe(false);
    expect(await b.promise).toBe(false);
    // 表项已删 —— 迟到的作答不再有挂靠点(idempotent for the held HTTP finally).
    expect(resolvePermission('p-a', true)).toBe(false);
    a.dispose();
    b.dispose();
  });

  test('agent narrowing only releases the matching agent, leaves others pending', async () => {
    const forge = registerPermission('p-forge', 60_000, { sid: 's2', agent: 'forge' });
    const iori = registerPermission('p-iori', 60_000, { sid: 's2', agent: 'iori' });

    expect(denyPermissionsForSession('s2', 'forge')).toEqual(['p-forge']);
    expect(await forge.promise).toBe(false);

    // iori's card is untouched — still answerable by the user.
    expect(resolvePermission('p-iori', true)).toBe(true);
    expect(await iori.promise).toBe(true);
    forge.dispose();
    iori.dispose();
  });

  test('does not touch a different session', async () => {
    const mine = registerPermission('p-mine', 60_000, { sid: 's3', agent: 'forge' });
    expect(denyPermissionsForSession('s-other')).toEqual([]);
    // mine still pending, still answerable.
    expect(resolvePermission('p-mine', true)).toBe(true);
    expect(await mine.promise).toBe(true);
    mine.dispose();
  });

  test('is a no-op after the request was already answered (normal path)', async () => {
    const h = registerPermission('p-done', 60_000, { sid: 's4', agent: 'forge' });
    expect(resolvePermission('p-done', true)).toBe(true);
    expect(await h.promise).toBe(true);
    // turn-end cleanup later finds nothing to release.
    expect(denyPermissionsForSession('s4')).toEqual([]);
    h.dispose();
  });
});
