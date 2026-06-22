// @desc Submit evolve mode code changes as a merge request, or close an existing MR
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { getTerminalManager } from "#src/terminal/manager.js";
import {
  detectCurrentBranch,
  detectRemoteDefaultBranch,
  getRemoteUrl,
  extractProjectPath,
} from "#src/git-common/git-utils.js";
import { createEvolvePR } from "../lib/evolve-pr.js";
import {
  upsertTrackedMR, closeTrackedMR, getTrackedMRs,
  readGitConfig, readToolKeys, gitTokenMissingMessage, deriveMrWebUrl,
} from "../lib/active-mrs.js";

function resolveBaseBranch(instanceRoot: string): string {
  try {
    const meta = JSON.parse(getSandboxFs().readTextSync(join(instanceRoot, ".instance-meta.json")));
    if (typeof meta.templateDir === "string") return detectCurrentBranch(meta.templateDir);
  } catch {}
  const current = detectCurrentBranch(instanceRoot);
  if (current === "HEAD" || current.startsWith("evolve/") || current.startsWith("feature/")) {
    try {
      const upstream = getTerminalManager().execSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: instanceRoot });
      const base = upstream.replace(/^origin\//, "");
      if (!base.startsWith("evolve/") && !base.startsWith("feature/")) return base;
    } catch {}
    try {
      const branches = getTerminalManager().execSync("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"], { cwd: instanceRoot }).split("\n");
      const workBranch = branches.find(b => !b.startsWith("evolve/") && !b.startsWith("feature/"));
      if (workBranch) return workBranch;
    } catch {}
    return detectRemoteDefaultBranch(instanceRoot);
  }
  return current;
}

async function createMergeRequest(
  apiBase: string, token: string, projectPath: string, remoteUrl: string,
  opts: { sourceBranch: string; targetBranch: string; title: string; description: string },
): Promise<{ webUrl: string; iid: number }> {
  const url = `${apiBase}/projects/${encodeURIComponent(projectPath)}/merge_requests`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PRIVATE-TOKEN": token },
    body: JSON.stringify({
      source_branch: opts.sourceBranch,
      target_branch: opts.targetBranch,
      title: opts.title,
      description: opts.description || undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitLab API ${res.status}: ${body}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const iid = (data.iid ?? data.id ?? 0) as number;
  const webUrl = (data.web_url as string) || deriveMrWebUrl(remoteUrl, iid);
  return { webUrl, iid };
}

async function fetchMRSourceBranch(
  apiBase: string, token: string, projectPath: string, iid: number,
): Promise<string | null> {
  const url = `${apiBase}/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`;
  try {
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return typeof data.source_branch === "string" ? data.source_branch : null;
  } catch {
    return null;
  }
}

async function findExistingMR(
  apiBase: string, token: string, projectPath: string, remoteUrl: string,
  sourceBranch: string,
): Promise<{ webUrl: string; iid: number } | null> {
  const url = `${apiBase}/projects/${encodeURIComponent(projectPath)}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`;
  try {
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    if (!res.ok) return null;
    const list = (await res.json()) as Record<string, unknown>[];
    if (!list.length) return null;
    const first = list[0];
    const iid = (first.iid ?? first.id ?? 0) as number;
    const webUrl = (first.web_url as string) || deriveMrWebUrl(remoteUrl, iid);
    return { webUrl, iid };
  } catch {
    return null;
  }
}

export default {
  name: "submit_mr",
  description:
    "Submit evolve mode code changes as a merge request, or close an existing MR. " +
    "Actions: 'submit' (default) creates/updates an MR from the explicitly selected files; " +
    "'close' closes a tracked MR by iid. " +
    "For 'submit' the 'files' parameter is REQUIRED (paths or directories) — leaving it " +
    "empty is no longer allowed, to prevent accidentally bundling unrelated uncommitted " +
    "changes into the MR. " +
    "To amend an existing MR, pass iid — the branch is auto-resolved from tracker or GitLab API. " +
    "Requires git_api_token in key/tools.json (with api scope).",
  guidance:
    "**submit_mr**: Call after LSP diagnostics pass. " +
    "Creates/updates GitLab MR from the files you explicitly list. " +
    "`files` is required for submit — pass file paths or directory prefixes " +
    "(e.g. `['src/llm/', 'docs/changelog/2026-04-18.md']`). " +
    "To amend an existing MR, pass `iid` — branch is auto-resolved. " +
    "Use action='close' + iid to close a tracked MR. " +
    "After submission, use `check_mr_status` to track merge/review progress.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["submit", "close"],
        description: "Action to perform. Default: 'submit'.",
      },
      title: {
        type: "string",
        description: "MR title in conventional commit format (required for submit).",
      },
      description: {
        type: "string",
        description: "MR description (markdown). Include motivation and key changes.",
      },
      branch: {
        type: "string",
        description: "Branch name suffix (auto-prefixed with 'evolve/'). Omit to auto-generate.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "File paths or directory prefixes to include (required for submit action). " +
          "A trailing '/' marks a directory prefix (e.g. 'src/llm/' matches all files under src/llm). " +
          "An exact path matches that single file. Must be non-empty for submit.",
      },
      iid: {
        type: "number",
        description: "MR iid. For submit: amend to this existing MR (auto-resolves branch). For close: close this MR.",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const action = String(args.action || "submit");

    // ── Close action ──
    // Local-only marking: some self-hosted GitLab v3 instances reject PUT to
    // /merge_requests/:id with 404 for both globalId and iid. Rather than
    // guess at v4/endpoint variants (would need new API base key), we mark
    // the MR closed in the tracker and instruct the user to close via the
    // GitLab web UI. No silent "successfully closed" messaging.
    if (action === "close") {
      const iid = args.iid as number;
      if (!iid) return '"iid" is required for close action.';

      const tracked = getTrackedMRs(ctx, { includeClosed: true });
      const target = tracked.find((m) => m.iid === iid);

      if (target?.status === "closed") {
        return `MR !${iid} is already marked closed locally (reason: ${target.closedReason ?? "unknown"}).`;
      }

      const instanceRoot = ctx.pathManager.root();
      const projectPath = target?.projectPath ?? extractProjectPath(getRemoteUrl(instanceRoot));
      closeTrackedMR(ctx, iid, projectPath, "manual");

      const url = target?.url ?? "(unknown)";
      return `✓ MR !${iid} marked closed in local tracking list ONLY.\n` +
        `⚠️  GitLab 上 MR 状态未改动 — 请手动在 UI 点 Close:\n${url}`;
    }

    // ── Submit action ──
    const title = String(args.title ?? "").trim();
    if (!title) return '"title" is required for submit action.';

    const files = Array.isArray(args.files) ? (args.files as string[]).map(String).filter(Boolean) : [];
    if (files.length === 0) {
      return '"files" is required for submit action — pass one or more file paths or directory prefixes ' +
        '(e.g. ["src/llm/", "docs/changelog/2026-04-18.md"]). ' +
        'Leaving it empty would bundle all uncommitted changes, which is error-prone.';
    }

    const description = args.description ? String(args.description).trim() : "";
    // ── Resolve branch: iid lookup → explicit branch → auto-generate ──
    let branch: string;
    if (args.iid) {
      const iid = args.iid as number;
      const tracked = getTrackedMRs(ctx, { includeClosed: false });
      const found = tracked.find(m => m.iid === iid);
      if (found?.branch) {
        branch = found.branch;
      } else {
        // Not in tracker — try GitLab API
        const instanceRoot = ctx.pathManager.root();
        const remoteUrlForLookup = getRemoteUrl(instanceRoot);
        const gitConfig = await readGitConfig(ctx, remoteUrlForLookup);
        if (gitConfig.token) {
          const projectPath = extractProjectPath(remoteUrlForLookup);
          const remoteBranch = await fetchMRSourceBranch(gitConfig.apiBase, gitConfig.token, projectPath, iid);
          if (remoteBranch) {
            branch = remoteBranch;
          } else {
            return `Cannot resolve branch for MR !${iid}: not in tracker and GitLab API returned nothing.`;
          }
        } else {
          return `Cannot resolve branch for MR !${iid}: not in tracker and no git_api_token configured.`;
        }
      }
    } else {
      const suffix = args.branch
        ? String(args.branch).trim().replace(/[^a-zA-Z0-9_\-/.]/g, "-")
        : `auto-${Date.now().toString(36)}`;
      branch = suffix.startsWith("evolve/") ? suffix : `evolve/${suffix}`;
    }

    const instanceRoot = ctx.pathManager.root();
    const baseBranch = resolveBaseBranch(instanceRoot);
    const remoteUrl = getRemoteUrl(instanceRoot);

    // When not using iid (explicit amend), reject if branch already has an open MR
    // to prevent accidental silent amends. Use iid to amend intentionally.
    if (!args.iid) {
      const gitConfigEarly = await readGitConfig(ctx, remoteUrl);
      if (gitConfigEarly.token) {
        const projectPathEarly = extractProjectPath(remoteUrl);
        const conflict = await findExistingMR(gitConfigEarly.apiBase, gitConfigEarly.token, projectPathEarly, remoteUrl, branch);
        if (conflict) {
          return `Branch \`${branch}\` already has an open MR: !${conflict.iid} (${conflict.webUrl}).\n` +
            `To amend it, use submit_mr(iid=${conflict.iid}, ...). To create a new MR, use a different branch name.`;
        }
      }
    }

    const prResult = createEvolvePR(instanceRoot, {
      requestedBy: ctx.agentId,
      ts: Date.now(),
      title,
      description,
      branch,
      files,
    }, baseBranch);

    if (prResult.error) return `Failed to create branch: ${prResult.error}`;

    const lines = [
      `Branch \`${prResult.branch}\` pushed (${prResult.commitHash}).`,
    ];
    if (prResult.filesChanged?.length) {
      const fileList = prResult.filesChanged.slice(0, 10).join(", ");
      const fileSuffix = prResult.filesChanged.length > 10 ? " ..." : "";
      lines.push(`Files (${prResult.filesChanged.length}): ${fileList}${fileSuffix}`);
    }

    const gitConfig = await readGitConfig(ctx, remoteUrl);
    if (!gitConfig.token) {
      const keysResult = await readToolKeys(ctx.pathManager);
      lines.push("");
      lines.push(gitTokenMissingMessage(keysResult.fileExists));
      lines.push("");
      lines.push("分支已推送，但 MR 未自动创建。配置 token 后重新调用 submit_mr 即可。");
      return lines.join("\n");
    }

    const projectPath = extractProjectPath(remoteUrl);

    // Check if MR already exists for this branch (update flow)
    const existingMR = await findExistingMR(gitConfig.apiBase, gitConfig.token, projectPath, remoteUrl, branch);
    if (existingMR) {
      lines.push(`Commits pushed to existing MR: ${existingMR.webUrl}`);
      if (prResult.isUpdate && files?.length) {
        lines.push(`Note: Updated existing branch — previous files were automatically preserved and merged with newly specified files.`);
      }

      upsertTrackedMR(ctx, {
        iid: existingMR.iid, branch, projectPath,
        apiBase: gitConfig.apiBase, url: existingMR.webUrl, createdAt: Date.now(),
      });

      if (ctx.teamBoard.get(ctx.agentId, "STATUS") === "evolve_mode") {
        ctx.teamBoard.set(ctx.agentId, "STATUS", "", { persist: true });
        lines.push("", "Evolve mode auto-deactivated. Use evolve_mode(enable=true) to re-enter.");
      }
      return lines.join("\n");
    }

    // First time: create new MR
    try {
      const mr = await createMergeRequest(gitConfig.apiBase, gitConfig.token, projectPath, remoteUrl, {
        sourceBranch: branch,
        targetBranch: baseBranch,
        title,
        description,
      });
      lines.push(`MR created: ${mr.webUrl}`);

      upsertTrackedMR(ctx, {
        iid: mr.iid, branch, projectPath,
        apiBase: gitConfig.apiBase, url: mr.webUrl, createdAt: Date.now(),
      });

      if (ctx.teamBoard.get(ctx.agentId, "STATUS") === "evolve_mode") {
        ctx.teamBoard.set(ctx.agentId, "STATUS", "", { persist: true });
        lines.push("", "Evolve mode auto-deactivated. Use evolve_mode(enable=true) to re-enter.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`MR API call failed: ${msg}`);
      if (prResult.url) lines.push(`Manual MR link: ${prResult.url}`);
      lines.push("", "Evolve mode remains active — fix the issue and retry submit_mr.");
    }

    return lines.join("\n");
  },
  formatDisplay(args, result) {
    const text = typeof result === "string" ? result : "";
    if (text.includes("git_api_token") && text.includes("未配置")) {
      return `⚠️ git_api_token 未配置。请在宿主机 ~/.agenteam/key/tools.json 中配置。`;
    }
    if (text.includes("Failed to create branch")) return `❌ 分支创建失败。`;
    if (text.startsWith("✓ MR !")) return text;
    const mrMatch = text.match(/MR created: (.+)/);
    if (mrMatch) return `✅ MR 已创建: ${mrMatch[1]}`;
    const existMatch = text.match(/Commits pushed to existing MR: (.+)/);
    if (existMatch) return `✅ 已推送到现有 MR: ${existMatch[1]}`;
    const branchMatch = text.match(/Branch `(.+?)` pushed/);
    if (branchMatch) return `📤 分支 ${branchMatch[1]} 已推送`;
    return undefined as any;
  },
} satisfies ToolDefinition;
