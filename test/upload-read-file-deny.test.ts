// The agent's read_file must refuse credential/.env files so a prompt-injected
// brief can't exfiltrate FORGEAX_UPLOAD_GITHUB_TOKEN / ANTHROPIC keys.

import { describe, expect, test } from "bun:test";
import { isSecretEnvFile } from "../builtin/kits/workspace/tools/read_file";

describe("isSecretEnvFile", () => {
  test("blocks .env and *.env", () => {
    expect(isSecretEnvFile("/home/you/proj/.env")).toBe(true);
    expect(isSecretEnvFile("/home/you/proj/.forgeax/dev-stack.env")).toBe(true);
    expect(isSecretEnvFile("/x/.env.local".replace(".local", ""))).toBe(true);
  });
  test("blocks key/pem/keys.yaml", () => {
    expect(isSecretEnvFile("/x/id_rsa.key")).toBe(true);
    expect(isSecretEnvFile("/x/cert.pem")).toBe(true);
    expect(isSecretEnvFile("/x/.forgeax/keys.yaml")).toBe(true);
  });
  test("allows ordinary files", () => {
    expect(isSecretEnvFile("/x/games/g/src/main.ts")).toBe(false);
    expect(isSecretEnvFile("/x/README.md")).toBe(false);
    expect(isSecretEnvFile("/x/environment.ts")).toBe(false);
  });
});
