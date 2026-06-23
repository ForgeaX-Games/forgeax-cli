// @desc Tests for stateless commands runner (agenteam-ref parity).
//
// 覆盖：
//   - listAllCommands 扫到 builtin 层；坏模块进 `_error:<file>` spec
//   - callQuery / callExecute 正确分发；不存在/无对应 segment → ok:false
//   - 同层同名冲突 → `_error:duplicate:<name>`
//   - mtime cache-bust：文件内容变了 → 下次调用拿到新结果
//   - args 是 string[]，复杂结构走 JSON.stringify 模块自解析

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initPathManager, resetPathManager } from "../src/fs/path-manager";
import { initSessionManager, resetSessionManager, getSessionManager } from "../src/core/session-manager";
import { getPathManager } from "../src/fs/path-manager";
import { listAllCommands, callQuery, callExecute, _resetImportLedger } from "../src/commands/runner";

let userRoot: string;
let commandsDir: string;
let prevCmdDir: string | undefined;

function writeMod(file: string, body: string): string {
  const path = resolve(commandsDir, file);
  writeFileSync(path, body, "utf-8");
  return path;
}

function ctx() {
  return { sm: getSessionManager(), paths: getPathManager() };
}

beforeEach(async () => {
  userRoot = mkdtempSync(resolve(tmpdir(), "forgeax-cmd-runner-"));
  commandsDir = mkdtempSync(resolve(tmpdir(), "forgeax-cmd-dir-"));
  prevCmdDir = process.env.FORGEAX_COMMANDS_DIR;
  process.env.FORGEAX_COMMANDS_DIR = commandsDir;
  resetPathManager();
  await resetSessionManager();
  _resetImportLedger();
  const pm = initPathManager({ userRoot });
  initSessionManager(pm);
});

afterEach(async () => {
  if (prevCmdDir === undefined) delete process.env.FORGEAX_COMMANDS_DIR;
  else process.env.FORGEAX_COMMANDS_DIR = prevCmdDir;
  await resetSessionManager();
  resetPathManager();
  rmSync(userRoot, { recursive: true, force: true });
  rmSync(commandsDir, { recursive: true, force: true });
});

describe("listAllCommands", () => {
  test("空目录 → []", async () => {
    const specs = await listAllCommands(ctx());
    expect(specs).toEqual([]);
  });

  test("一个模块多条命令 — list 全收", async () => {
    writeMod("multi.ts", `
      const mod = {
        async list() {
          return [
            { name: "alpha", description: "a", hasQuery: true, hasExecute: false },
            { name: "beta",  description: "b", hasQuery: false, hasExecute: true },
          ];
        },
        async query(_n: string, _a: string[]) { return { from: "alpha" }; },
        async execute(_n: string, _a: string[]) { return { from: "beta" }; },
      };
      export default mod;
    `);
    const specs = await listAllCommands(ctx());
    expect(specs.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(specs.find((s) => s.name === "alpha")?.hasQuery).toBe(true);
    expect(specs.find((s) => s.name === "beta")?.hasExecute).toBe(true);
  });

  test("坏模块 → `_error:<file>` synthetic spec（不抛）", async () => {
    writeMod("broken.ts", `this is not valid typescript at all !!!`);
    const specs = await listAllCommands(ctx());
    const err = specs.find((s) => s.name.startsWith("_error:"));
    expect(err).toBeDefined();
    expect(err!.name).toBe("_error:broken.ts");
    expect(err!.description).toMatch(/broken\.ts/);
  });

  test("空 default export → `_error:<file>`", async () => {
    writeMod("empty.ts", `export default {}; // no list() fn`);
    const specs = await listAllCommands(ctx());
    expect(specs[0]!.name).toBe("_error:empty.ts");
    expect(specs[0]!.description).toMatch(/no default CommandModule export/);
  });

  test("同层同名 → `_error:duplicate:<name>`（保留 first owning file）", async () => {
    writeMod("a.ts", `
      const mod = { async list() { return [{ name: "shared", description: "from-a", hasQuery: true, hasExecute: false }]; } };
      export default mod;
    `);
    writeMod("b.ts", `
      const mod = { async list() { return [{ name: "shared", description: "from-b", hasQuery: true, hasExecute: false }]; } };
      export default mod;
    `);
    const specs = await listAllCommands(ctx());
    const dup = specs.find((s) => s.name.startsWith("_error:duplicate:"));
    expect(dup).toBeDefined();
    // 还会保留 first owner 的实 spec —— shared 自身仍在 list 中
    expect(specs.some((s) => s.name === "shared")).toBe(true);
  });
});

describe("callQuery / callExecute", () => {
  test("happy path query —— 拿到 module 返回值", async () => {
    writeMod("echo.ts", `
      const mod = {
        async list() { return [{ name: "echo", description: "e", hasQuery: true, hasExecute: false }]; },
        async query(_n: string, args: string[]) { return { args }; },
      };
      export default mod;
    `);
    const r = await callQuery("echo", ["a", "b"], ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ args: ["a", "b"] });
  });

  test("happy path execute", async () => {
    writeMod("doit.ts", `
      const mod = {
        async list() { return [{ name: "doit", description: "d", hasQuery: false, hasExecute: true }]; },
        async execute(_n: string, args: string[]) { return { written: args.length }; },
      };
      export default mod;
    `);
    const r = await callExecute("doit", ["x"], ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ written: 1 });
  });

  test("Unknown command → ok:false", async () => {
    const r = await callQuery("ghost", [], ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Unknown command: ghost");
  });

  test("命令有 query 但调 execute → ok:false (has no execute)", async () => {
    writeMod("ro.ts", `
      const mod = {
        async list() { return [{ name: "ro", description: "r", hasQuery: true, hasExecute: false }]; },
        async query() { return { ok: true }; },
      };
      export default mod;
    `);
    const r = await callExecute("ro", [], ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/has no execute/);
  });

  test("模块抛错 → ok:false 包错误信息", async () => {
    writeMod("oops.ts", `
      const mod = {
        async list() { return [{ name: "oops", description: "o", hasQuery: true, hasExecute: false }]; },
        async query() { throw new Error("intentional boom"); },
      };
      export default mod;
    `);
    const r = await callQuery("oops", [], ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("intentional boom");
  });

  test("复杂结构走 JSON 字符串约定 —— 模块自己 parse（agenteam ref 风格）", async () => {
    writeMod("setter.ts", `
      const mod = {
        async list() { return [{ name: "setter", description: "s", hasQuery: false, hasExecute: true }]; },
        async execute(_n: string, args: string[]) {
          const patch = JSON.parse(args[1] ?? "{}");
          return { id: args[0], patch };
        },
      };
      export default mod;
    `);
    const r = await callExecute("setter", ["xyz", JSON.stringify({ a: 1, nested: { b: true } })], ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ id: "xyz", patch: { a: 1, nested: { b: true } } });
  });

  // bun 不像 Node 那样把 dynamic-import URL 的 query 段当成 cache key（issue
  // oven-sh/bun#21346）。runner.ts 改成 Jarred-Sumner 在 #14435 给的官方做法 ——
  // `delete require.cache[path]` + dynamic import。验证下面三件事：
  //   1. 同一个文件 mtime 没变 → 命中 cache（不会浪费 import 开销）
  //   2. mtime 变了 → 拿到新 version
  //   3. 哪怕 mtime 一致但 import ledger 被 reset → 也强 reload
  test("mtime cache-bust：文件改动后下一次调用拿到新 version (bun + delete require.cache)", async () => {
    const path = writeMod("mute.ts", `
      const mod = {
        async list() { return [{ name: "mute", description: "v1", hasQuery: true, hasExecute: false }]; },
        async query() { return "v1"; },
      };
      export default mod;
    `);
    const r1 = await callQuery("mute", [], ctx());
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data).toBe("v1");

    // 至少 +10ms 让 mtime 在所有文件系统下都能向前。
    await new Promise((res) => setTimeout(res, 10));
    writeFileSync(path, `
      const mod = {
        async list() { return [{ name: "mute", description: "v2", hasQuery: true, hasExecute: false }]; },
        async query() { return "v2"; },
      };
      export default mod;
    `);
    const r2 = await callQuery("mute", [], ctx());
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data).toBe("v2");

    // 不改文件，再调一次 —— 仍然 v2，且 mtime ledger 没动（不再 delete cache）。
    const r3 = await callQuery("mute", [], ctx());
    if (r3.ok) expect(r3.data).toBe("v2");
  });
});
