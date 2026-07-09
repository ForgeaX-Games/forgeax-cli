// Unit tests for upload config + namespace resolution.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeNamespace,
  loadUploadConfig,
  resolveNamespace,
  resolvePlanContext,
  uploadStateFile,
  UploadConfigError,
} from "../src/upload/config";

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "fg-cfg-"));
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe("namespace", () => {
  test("default form is <slug>-<sha256[:12]> with >=12 hex", () => {
    const ns = computeNamespace(projectRoot, { FORGEAX_UPLOAD_NAMESPACE: "" } as any);
    const hashPart = ns.split("-").pop()!;
    expect(hashPart).toMatch(/^[0-9a-f]{12}$/);
  });
  test("explicit FORGEAX_UPLOAD_NAMESPACE overrides", () => {
    const ns = computeNamespace(projectRoot, { FORGEAX_UPLOAD_NAMESPACE: "My Team!!" } as any);
    expect(ns).toBe("my-team");
  });
  test("stable + persisted once, read back verbatim", () => {
    const ns1 = resolveNamespace(projectRoot, {} as any);
    expect(existsSync(uploadStateFile(projectRoot))).toBe(true);
    const ns2 = resolveNamespace(projectRoot, {} as any);
    expect(ns2).toBe(ns1);
    const stored = JSON.parse(readFileSync(uploadStateFile(projectRoot), "utf8"));
    expect(stored.namespace).toBe(ns1);
    expect(stored.version).toBe(1);
    // upload.json holds ONLY the namespace identity (no token, no lastUpload mirror)
    expect(Object.keys(stored).sort()).toEqual(["namespace", "version"]);
  });
  test("different project roots → different namespaces (hash differs)", () => {
    const other = mkdtempSync(join(tmpdir(), "fg-cfg2-"));
    const a = computeNamespace(projectRoot, {} as any);
    const b = computeNamespace(other, {} as any);
    expect(a).not.toBe(b);
    rmSync(other, { recursive: true, force: true });
  });
});

describe("loadUploadConfig fail-fast", () => {
  test("no token → UploadConfigError(no-token)", () => {
    try {
      loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r" } as any });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UploadConfigError);
      expect((e as UploadConfigError).kind).toBe("no-token");
    }
  });
  test("invalid repo format → UploadConfigError(no-repo); missing repo falls back to shared default", () => {
    // No env repo → DEFAULT_UPLOAD_REPO (shared org repo) applies, no error.
    const viaDefault = loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_GITHUB_TOKEN: "tok" } as any });
    expect(viaDefault.repo).toMatch(/^[^\/]+\/[^\/]+$/);
    try {
      loadUploadConfig({ projectRoot, env: { FORGEAX_UPLOAD_GITHUB_TOKEN: "tok", FORGEAX_UPLOAD_REPO: "not-a-repo" } as any });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UploadConfigError).kind).toBe("no-repo");
    }
  });
  test("valid config resolves", () => {
    const cfg = loadUploadConfig({
      projectRoot,
      env: { FORGEAX_UPLOAD_GITHUB_TOKEN: "tok", FORGEAX_UPLOAD_REPO: "owner/repo", FORGEAX_UPLOAD_BRANCH: "dev" } as any,
    });
    expect(cfg.repo).toBe("owner/repo");
    expect(cfg.branch).toBe("dev");
    expect(cfg.token).toBe("tok");
    expect(cfg.sourceRoot).toBe(join(projectRoot, ".forgeax"));
    expect(cfg.namespace).toMatch(/[0-9a-f]{12}$/);
  });
});

describe("resolvePlanContext", () => {
  test("does not require token; reports tokenConfigured", () => {
    const ctx = resolvePlanContext({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r" } as any });
    expect(ctx.tokenConfigured).toBe(false);
    const ctx2 = resolvePlanContext({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "o/r", FORGEAX_UPLOAD_GITHUB_TOKEN: "tok" } as any });
    expect(ctx2.tokenConfigured).toBe(true);
  });
  test("empty env falls back to the shared default repo; invalid format still throws", () => {
    expect(resolvePlanContext({ projectRoot, env: {} as any }).repo).toMatch(/^[^/]+\/[^/]+$/);
    expect(() => resolvePlanContext({ projectRoot, env: { FORGEAX_UPLOAD_REPO: "not-a-repo" } as any })).toThrow();
  });
});
