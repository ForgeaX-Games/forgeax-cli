/** delegate-guard — delegationGuard 纯函数单测
 *
 *  覆盖四个场景：
 *  1. target busy（target 已经有一个 pending delegation）→ block
 *  2. 并发超限（delegations.size >= maxConcurrent）→ block
 *  3. 循环委托（delegator 是 target 的子孙，如 "forge/iori" → "forge"）→ block
 *  4. 正常情况（空 map，不同 agent）→ allow
 */

import { describe, expect, test } from "bun:test";
import { delegationGuard } from "../builtin/kits/agent_manage/tools/delegate_to_subagent";

describe("delegationGuard", () => {
  test("target busy: target already has a pending delegation → block", () => {
    const delegations = new Map<string, { delegator: string }>([
      ["suzu", { delegator: "forge" }],
    ]);
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "suzu",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/target busy/);
  });

  test("too many concurrent: size >= maxConcurrent → block", () => {
    // 填满 8 个 pending（默认 maxConcurrent = 8）
    const delegations = new Map<string, { delegator: string }>(
      Array.from({ length: 8 }, (_, i) => [`agent-${i}`, { delegator: "forge" }]),
    );
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "new-agent", // 新 target，不在 map 里
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/too many concurrent/);
  });

  test("cycle: delegator 'forge/iori' delegating to ancestor 'forge' → block", () => {
    const delegations = new Map<string, { delegator: string }>();
    const result = delegationGuard({
      delegations,
      delegator: "forge/iori",
      target: "forge",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/cycle/);
  });

  test("cycle: delegator === target → block", () => {
    const delegations = new Map<string, { delegator: string }>();
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "forge",
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/cycle/);
  });

  test("normal: empty map, different agents → allow", () => {
    const delegations = new Map<string, { delegator: string }>();
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "suzu",
    });
    expect(result.block).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("normal: map has entries for different targets, not over limit → allow", () => {
    const delegations = new Map<string, { delegator: string }>([
      ["suzu", { delegator: "forge" }],
      ["rin", { delegator: "forge" }],
    ]);
    // mochi is a new target, map size=2 < 8
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "mochi",
    });
    expect(result.block).toBe(false);
  });

  test("custom maxConcurrent: size >= custom limit → block", () => {
    const delegations = new Map<string, { delegator: string }>([
      ["suzu", { delegator: "forge" }],
      ["rin", { delegator: "forge" }],
    ]);
    // size=2, maxConcurrent=2 → should block
    const result = delegationGuard({
      delegations,
      delegator: "forge",
      target: "mochi",
      maxConcurrent: 2,
    });
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/too many concurrent/);
  });
});
