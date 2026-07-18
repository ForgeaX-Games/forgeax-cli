// A1#4 — per-turn 中立权限闸(in-process registry)单元行为 + 接线回归守卫。
//
// 背景:CC 内核 runTurn 时把编排层的 `req.requestPermission` 经 registerTurnGate
// 登记(键=真实 sid);`/:sid/permission-request` 处理器进卡前先 consultTurnGate
// 咨询本闸。该跨文件接线曾被静默删两次(无测试守 → cli 全绿照旧),本文件钉住它。
import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerTurnGate,
  consultTurnGate,
  releaseTurnGate,
} from '../src/kernel/cc-profile';
import type { PermissionDecision } from '@forgeax/agent-runtime/contract';

const SID = 'sid-turn-gate-test';

afterEach(() => releaseTurnGate(SID));

describe('turn gate — registry 单元行为', () => {
  test('registerTurnGate:空 sid → false,有 sid+gate → true', () => {
    expect(registerTurnGate('', async () => ({ behavior: 'allow' }))).toBe(false);
    expect(registerTurnGate(SID, async () => ({ behavior: 'allow' }))).toBe(true);
  });

  test('未登记 → consultTurnGate 返回 undefined(回落弹卡)', async () => {
    expect(await consultTurnGate('no-such-sid', { name: 'Bash', args: null })).toBeUndefined();
  });

  test('命中 → 透传 gate 的 allow 决策', async () => {
    registerTurnGate(SID, async () => ({ behavior: 'allow' }));
    const d = await consultTurnGate(SID, { name: 'Read', args: { path: '/x' } });
    expect(d).toEqual({ behavior: 'allow' });
  });

  test('命中 → 透传 gate 的 deny 决策(含 message)', async () => {
    registerTurnGate(SID, async () => ({ behavior: 'deny', message: 'nope' }));
    const d = (await consultTurnGate(SID, { name: 'Bash', args: { command: 'rm' } }))!;
    expect(d.behavior).toBe('deny');
    expect((d as Extract<PermissionDecision, { behavior: 'deny' }>).message).toBe('nope');
  });

  test('gate 抛错 → fail-closed deny(绝不静默放行)', async () => {
    registerTurnGate(SID, async () => {
      throw new Error('boom');
    });
    const d = (await consultTurnGate(SID, { name: 'Bash', args: null }))!;
    expect(d.behavior).toBe('deny');
    expect((d as Extract<PermissionDecision, { behavior: 'deny' }>).message).toContain('boom');
  });

  test('releaseTurnGate 后 → 再 consult 返回 undefined(幂等)', async () => {
    registerTurnGate(SID, async () => ({ behavior: 'allow' }));
    releaseTurnGate(SID);
    releaseTurnGate(SID); // 幂等
    expect(await consultTurnGate(SID, { name: 'Read', args: null })).toBeUndefined();
  });
});

describe('turn gate — 接线回归守卫(防静默删)', () => {
  test('api/sessions.ts 的 permission-request 处理器确有 consultTurnGate 接线', () => {
    const src = readFileSync(join(import.meta.dir, '../src/api/sessions.ts'), 'utf8');
    // 既要 import,也要在处理器里真正 await 调用——两者缺一即视为接线被删。
    expect(src).toContain("consultTurnGate } from '../kernel/cc-profile'");
    expect(src).toContain('await consultTurnGate(sid,');
  });
});
