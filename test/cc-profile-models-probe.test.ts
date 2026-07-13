// probeStreamJsonModels — stream-json 控制面模型探测的单测。
//
// 契约:
// - 发 initialize control_request,取响应 `models`;id/value、name/displayName
//   两种拼写(cc 与 cbc 分叉)都接;label 与 id 相同或缺省时省略。
// - 响应里的 account(含登录 token)整体丢弃 —— 返回值里绝不出现。
// - 进程不应答 → timeoutMs 后 reject;binary 不存在 → reject(编排层降级)。
//
// 假 CLI = 临时可执行 sh 脚本包 bun -e(probe 的 argv 是固定 flags,脚本忽略之)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeStreamJsonModels } from "../src/kernel/cc-profile";

let dir: string;

function fakeCli(name: string, inlineJs: string): string {
  const js = join(dir, `${name}.mjs`);
  writeFileSync(js, inlineJs, "utf-8");
  const sh = join(dir, name);
  writeFileSync(sh, `#!/bin/sh\nexec ${process.execPath} ${js}\n`, "utf-8");
  chmodSync(sh, 0o755);
  return sh;
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "forgeax-ccprobe-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("probeStreamJsonModels", () => {
  test("parses both cc(value/displayName) and cbc(id/name) row shapes; drops account", async () => {
    const bin = fakeCli("ok-cli", `
      process.stdin.on('data', (d) => {
        const req = JSON.parse(d.toString());
        process.stdout.write(JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: req.request_id,
            response: {
              models: [
                { id: 'glm-5.1-ioa', name: 'GLM-5.1' },          // cbc 拼写
                { value: 'opus', displayName: 'Opus' },           // cc 拼写
                { id: 'auto', name: 'auto' },                     // label==id → 省略
                { id: '' },                                       // 空 id → 丢弃
              ],
              account: { token: 'SECRET-DO-NOT-LEAK' },
            },
          },
        }) + '\\n');
      });
      setTimeout(() => {}, 60_000); // 保活等 probe kill
    `);
    const models = await probeStreamJsonModels(bin, 10_000);
    expect(models).toEqual([
      { id: "glm-5.1-ioa", label: "GLM-5.1" },
      { id: "opus", label: "Opus" },
      { id: "auto" },
    ]);
    expect(JSON.stringify(models)).not.toContain("SECRET");
  });

  test("unresponsive CLI → rejects after timeoutMs", async () => {
    const bin = fakeCli("silent-cli", `setTimeout(() => {}, 60_000);`);
    await expect(probeStreamJsonModels(bin, 500)).rejects.toThrow(/timed out/);
  });

  test("missing binary → rejects (resolver degrades to next tier)", async () => {
    await expect(probeStreamJsonModels(join(dir, "no-such-cli"), 3_000)).rejects.toThrow();
  });
});
