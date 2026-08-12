import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");

function job(name, nextName) {
  const start = workflow.indexOf("  " + name + ":\n");
  assert.notEqual(start, -1, "missing " + name + " job");
  const end = nextName ? workflow.indexOf("  " + nextName + ":\n", start + 1) : workflow.length;
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test("uses the canonical release triggers and immutable action pins", () => {
  assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]\n  workflow_dispatch:\n/u);
  for (const action of [
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  ]) {
    assert.ok(workflow.includes(action), "missing immutable action " + action);
  }
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v\d/u);
  assert.match(workflow, /persist-credentials: false/u);
});

test("separates build, scan, and publish onto fresh jobs", () => {
  assert.match(workflow, /^  build:\n/mu);
  assert.match(workflow, /^  scan:\n    needs: build\n/mu);
  assert.match(workflow, /^  publish:\n    needs: scan\n/mu);
  assert.match(job("build", "scan"), /name: npm-candidate/u);
  assert.match(job("scan", "publish"), /name: npm-scanned/u);
});

test("uses deterministic package checks instead of environment-sensitive E2E tests", () => {
  const buildJob = job("build", "scan");
  assert.match(buildJob, /bun test test\/npm-contract-independence\.test\.ts/u);
  assert.match(buildJob, /bun run typecheck/u);
  assert.match(buildJob, /bun run build/u);
  assert.doesNotMatch(buildJob, /bun run test(?:\s|$)/u);
});

test("captures the tarball path in the pack step without reading its own deferred output", () => {
  const buildJob = job("build", "scan");
  assert.match(buildJob, /tarball="\$\(node scripts\/pack-release\.mjs --destination "\$pack_directory"\)"/u);
  assert.doesNotMatch(buildJob, /tarball="\$\{\{ steps\.pack\.outputs\.tarball \}\}"/u);
});

test("scans the extracted package without exclusions before re-upload", () => {
  const scanJob = job("scan", "publish");
  assert.match(scanJob, /verify-release-artifact\.py/u);
  assert.match(scanJob, /check-release-secrets\.mjs --mode package/u);
  assert.match(scanJob, /run-trufflehog-release-scan\.sh --mode package/u);
  assert.match(scanJob, /outputs:\n      sha256: \$\{\{ steps\.verify\.outputs\.sha256 \}\}/u);
});

test("keeps package code and npm credentials out of the publish runner", () => {
  const publishJob = job("publish");
  assert.equal((workflow.match(/NPM_TOKEN/gu) ?? []).length, 1);
  assert.doesNotMatch(publishJob, /actions\/checkout|bun install|npm pack|node scripts\/|verify-release-artifact/u);
  assert.match(publishJob, /needs\.scan\.outputs\.sha256/u);
  assert.match(publishJob, /npm publish "\$tarball" --access public --ignore-scripts/u);
  assert.match(publishJob, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/u);
});

test("pins npm before publishing", () => {
  const publishJob = job("publish");
  const pinnedNpm = "npm install --global npm@11.19.0 --ignore-scripts";
  assert.ok(publishJob.indexOf(pinnedNpm) < publishJob.indexOf("npm publish"));
});
