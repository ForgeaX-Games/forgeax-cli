// kernel/model-catalog — 五层回退链(env → listModels → last-known →
// static → none)的单测。真实获取统一在各内核 listModels(),编排层不再有
// 通用 probe runner。
//
// 契约:
// - 每层失败(未定义/抛错/空结果)降到下一层,`source` 如实标注命中层。
// - 上层失败原因保留在 `error` 里,即使下层成功(降级可见,§9)。
// - 层 1/2 成功后把结果幂等写进 ~/.forgeax/key/kernel-models-<id>.json,
//   之后探测失败时作为 last-known 层回放。
// - unknown kernelId → 空态 + error 列出可用内核(UI 查询路径不 500)。
//
// 用 registerKernel/unregisterKernel 挂假内核(唯一 id,不碰真内核)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerKernel, unregisterKernel, type AgentKernel, type KernelCapabilities } from "@forgeax/agent-runtime";
import { resolveKernelModelCatalog, _resetModelCatalogCache } from "../src/kernel/model-catalog";

const CAPS: KernelCapabilities = {
  streaming: false,
  thinking: false,
  toolCalls: false,
  midTurnInject: false,
  forkExtract: false,
};

/** 最小假内核:runTurn/openHandle/probe 在本测试里永不被调。 */
function fakeKernel(id: string, extra: Partial<AgentKernel> = {}): AgentKernel {
  return {
    id,
    capabilities: CAPS,
    async *runTurn() { /* unused */ },
    openHandle() { throw new Error("unused"); },
    async probe() { return { ok: true, kernelId: id }; },
    ...extra,
  } as AgentKernel;
}

let keyRoot: string;
let prevTtl: string | undefined;
const registered: string[] = [];

function ctx() {
  return { paths: { user: () => ({ keyDir: () => keyRoot }) } };
}

function mount(k: AgentKernel): void {
  registerKernel(k);
  registered.push(k.id);
}

beforeEach(() => {
  keyRoot = mkdtempSync(resolve(tmpdir(), "forgeax-modelcat-"));
  prevTtl = process.env.FORGEAX_DRIVER_MODEL_CACHE_TTL_MS;
  process.env.FORGEAX_DRIVER_MODEL_CACHE_TTL_MS = "0"; // 缺省关缓存,缓存单测自己开
  _resetModelCatalogCache();
});

afterEach(() => {
  for (const id of registered.splice(0)) unregisterKernel(id);
  if (prevTtl === undefined) delete process.env.FORGEAX_DRIVER_MODEL_CACHE_TTL_MS;
  else process.env.FORGEAX_DRIVER_MODEL_CACHE_TTL_MS = prevTtl;
  rmSync(keyRoot, { recursive: true, force: true });
  _resetModelCatalogCache();
});

describe("resolveKernelModelCatalog — fallback chain", () => {
  test("tier 0: env override wins over everything", async () => {
    mount(fakeKernel("fake-env-kernel", {
      listModels: async () => ({ models: [{ id: "from-kernel" }], source: "kernel" as const }),
    }));
    process.env.FORGEAX_FAKE_ENV_KERNEL_MODELS = "m-a, m-b";
    try {
      const res = await resolveKernelModelCatalog("fake-env-kernel", ctx());
      expect(res.source).toBe("env");
      expect(res.models.map((m) => m.id)).toEqual(["m-a", "m-b"]);
    } finally {
      delete process.env.FORGEAX_FAKE_ENV_KERNEL_MODELS;
    }
  });

  test("tier 1: kernel.listModels() is the business-defined source", async () => {
    mount(fakeKernel("fake-lm", {
      displayName: "Fake LM",
      listModels: async () => ({ models: [{ id: "k-1", reasoning: true }], source: "kernel" as const }),
      fallbackModels: ["never-used"],
    }));
    const res = await resolveKernelModelCatalog("fake-lm", ctx());
    expect(res.source).toBe("kernel");
    expect(res.models).toEqual([{ id: "k-1", reasoning: true }]);
    expect(res.kernelDisplayName).toBe("Fake LM");
    // last-known 持久化
    const file = join(keyRoot, "kernel-models-fake-lm.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).models[0].id).toBe("k-1");
  });



  test("tier 2: last-known disk cache replays the previous successful fetch", async () => {
    mkdirSync(keyRoot, { recursive: true });
    writeFileSync(
      join(keyRoot, "kernel-models-fake-lk.json"),
      JSON.stringify({ fetchedAt: "2026-07-01T00:00:00Z", models: [{ id: "lk-1" }] }),
      "utf-8",
    );
    mount(fakeKernel("fake-lk", {
      listModels: async () => { throw new Error("offline"); },
      fallbackModels: ["static-never-reached"],
    }));
    const res = await resolveKernelModelCatalog("fake-lk", ctx());
    expect(res.source).toBe("last-known");
    expect(res.models.map((m) => m.id)).toEqual(["lk-1"]);
    expect(res.error).toMatch(/offline/);
  });

  test("tier 3: kernel-author static fallbackModels", async () => {
    mount(fakeKernel("fake-static", { fallbackModels: ["s-1", "s-2"] }));
    const res = await resolveKernelModelCatalog("fake-static", ctx());
    expect(res.source).toBe("static");
    expect(res.models.map((m) => m.id)).toEqual(["s-1", "s-2"]);
  });

  test("tier 4: nothing configured → empty state, never a fake list", async () => {
    mount(fakeKernel("fake-none"));
    const res = await resolveKernelModelCatalog("fake-none", ctx());
    expect(res.source).toBe("none");
    expect(res.models).toEqual([]);
    expect(res.error).toMatch(/no model discovery configured/);
  });

  test("unknown kernel id → empty state with available-kernels hint (no throw)", async () => {
    const res = await resolveKernelModelCatalog("no-such-kernel", ctx());
    expect(res.source).toBe("none");
    expect(res.models).toEqual([]);
    expect(res.error).toMatch(/unknown kernel 'no-such-kernel'/);
    expect(res.error).toMatch(/claude-code/); // 可用清单里至少有自带内核
  });

  test("TTL cache: second call within window reuses the resolved value", async () => {
    process.env.FORGEAX_DRIVER_MODEL_CACHE_TTL_MS = "60000";
    let calls = 0;
    mount(fakeKernel("fake-cache", {
      listModels: async () => {
        calls++;
        return { models: [{ id: "c-1" }], source: "kernel" as const };
      },
    }));
    const a = await resolveKernelModelCatalog("fake-cache", ctx());
    const b = await resolveKernelModelCatalog("fake-cache", ctx());
    expect(calls).toBe(1);
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBe(true);
    expect(b.models.map((m) => m.id)).toEqual(["c-1"]);
  });
});

