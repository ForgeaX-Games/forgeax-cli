/**
 * @desc Instance Provision — 确保 Instance 运行环境健康。
 *
 * 每次 start 前调用 ensureProvisioned()，幂等地保证：
 *   目录存在 → 独立 clone 正确 → sparse-checkout 正确 → 依赖已装。
 *
 * 纯环境操作，不涉及 meta 注册。
 */

import { existsSync, statSync, mkdirSync, rmSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export function resolveInstanceDir(stateDir: string, instanceId: string): string {
  return join(stateDir, "instances", instanceId);
}

/**
 * 确保 Instance 环境就绪，start 前必调。幂等。
 *
 * 三种状态自动处理：
 * 1. 目录不存在 → 从本地主仓库 clone + 配置独立身份 + 装依赖
 * 2. 目录存在且 .git 是目录（合法 clone）→ 装依赖
 * 3. 目录存在但 .git 是文件（旧 worktree）→ 保留运行时数据，迁移为独立 clone
 */
export async function ensureProvisioned(instanceDir: string, instanceId: string, templateDir: string): Promise<void> {
  if (!existsSync(instanceDir)) {
    await createClone(instanceDir, instanceId, templateDir);
  } else {
    const gitPath = join(instanceDir, ".git");
    const isWorktree = existsSync(gitPath) && statSync(gitPath).isFile();
    if (isWorktree) {
      await migrateToClone(instanceDir, instanceId, templateDir);
    } else if (!existsSync(gitPath) || !statSync(gitPath).isDirectory()) {
      await createClone(instanceDir, instanceId, templateDir);
    }
  }

  // Common post-clone setup (all idempotent)
  ensureOriginUrl(instanceDir, templateDir);
  ensureGitIdentity(instanceDir, instanceId);
  ensurePrePushHook(instanceDir);
  ensureCleanGitState(instanceDir);
  ensureDeps(instanceDir, instanceId);
}

/**
 * 销毁 Instance 运行环境。
 */
export function removeInstance(instanceDir: string, _instanceId: string, _templateDir: string): void {
  if (!existsSync(instanceDir)) return;
  rmSync(instanceDir, { recursive: true, force: true });
}

// ─── Internal ───

async function createClone(instanceDir: string, instanceId: string, templateDir: string): Promise<void> {
  console.log(`[Provision] Cloning repo for "${instanceId}" ...`);
  // Only treat the template as a real git repo when `.git` is a DIRECTORY.
  // When it's a file (`gitdir: ...`), the template is a git submodule checkout
  // or worktree — `git clone <path>` against it would either fail or produce
  // an unintended secondary clone of the parent's superproject. Fall through
  // to cpSync in that case (matches the pre-zero-build build-mirror behaviour).
  const gitPath = join(templateDir, ".git");
  const hasGit = existsSync(gitPath) && statSync(gitPath).isDirectory();
  if (hasGit) {
    execSync(`git clone "${templateDir}" "${instanceDir}"`, {
      stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
  } else {
    mkdirSync(instanceDir, { recursive: true });
    const { cpSync, readdirSync, rmSync: rm } = await import("node:fs");
    // Node 22 regression: cpSync with `force:true + verbatimSymlinks:true`
    // does NOT overwrite an existing dest entry when the source is a symlink —
    // the onLink path calls symlinkSync directly without unlinking. Hits us
    // when an earlier cpSync ran WITHOUT verbatimSymlinks (older cli build)
    // and dereferenced the template's symlinks into plain files at dest; the
    // current run then EEXIST's trying to recreate them as symlinks.
    // Pre-walk the template and clear any dest entry whose source is a symlink.
    const stripDestForTemplateSymlinks = (src: string, dest: string): void => {
      let entries: import("node:fs").Dirent[];
      try { entries = readdirSync(src, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const srcPath = join(src, e.name);
        const destPath = join(dest, e.name);
        if (e.isSymbolicLink()) {
          try { rm(destPath, { recursive: true, force: true }); } catch {}
        } else if (e.isDirectory()) {
          stripDestForTemplateSymlinks(srcPath, destPath);
        }
      }
    };
    stripDestForTemplateSymlinks(templateDir, instanceDir);
    cpSync(templateDir, instanceDir, {
      recursive: true, force: true,
      // verbatimSymlinks: keep symlinks as-is; without this, Node resolves
      // the symlink's target via realpath and writes an absolute-path symlink
      // pointing back into the source tree. Then any subsequent cp re-attempt
      // hits ERR_FS_CP_EINVAL ("cannot copy X to a subdirectory of self")
      // because the dest symlink dereferences to a file inside src.
      // Triggered by nested submodule docs/agentic-design-patterns/CLAUDE.md
      // → AGENTS.md.
      verbatimSymlinks: true,
      // Skip node_modules (huge, will re-install) and .git (templates that
      // are git submodule checkouts carry a .git FILE pointing to a gitdir
      // that's relative to the template — copying it leaves an orphan
      // pointer that migrateToClone later misinterprets as a worktree).
      filter: (src) => {
        if (src.includes("node_modules")) return false;
        const base = src.split(/[\\/]/).pop();
        if (base === ".git") return false;
        return true;
      },
    });
  }
}

/**
 * Verify `instanceDir` has its own .git before running git config/remote
 * commands with cwd: instanceDir. If absent, git walks up parent directories
 * and silently operates on a host repo above us — this is exactly how
 * cli daemon used to clobber forgeax-studio/.git/config (origin URL + user
 * section) when state-dir landed inside the studio repo via
 * ~/.agenteam → studio/.forgeax/agenteam-state symlink. The cpSync clone
 * path in createClone (template is a submodule, .git is a file) explicitly
 * skips .git, leaving the instance without one — so this guard is load-
 * bearing for the forgeax default-instance case.
 */
function hasOwnGitRepo(instanceDir: string): boolean {
  // .git can be a directory (real clone) or a file (worktree gitlink).
  // Both anchor git to this instance; missing means git walks up.
  return existsSync(join(instanceDir, ".git"));
}

/**
 * Ensure instance origin points to the template's real remote URL (not its local path).
 * Called on every start so that changes to the template's remote are propagated.
 */
function ensureOriginUrl(instanceDir: string, templateDir: string): void {
  if (!hasOwnGitRepo(instanceDir)) {
    console.warn(`[Provision] ensureOriginUrl skipped — "${instanceDir}" has no own .git (would clobber host repo above).`);
    return;
  }
  try {
    const templateRemote = execSync("git remote get-url origin", {
      cwd: templateDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
    }).trim();
    if (!templateRemote) return;

    const instanceRemote = execSync("git remote get-url origin", {
      cwd: instanceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
    }).trim();

    if (instanceRemote !== templateRemote) {
      execSync(`git remote set-url origin "${templateRemote}"`, {
        cwd: instanceDir, stdio: ["ignore", "pipe", "pipe"],
      });
      console.log(`[Provision] Updated origin for "${instanceDir}" → ${templateRemote}`);
    }
  } catch {
    // Template has no remote or git unavailable — leave origin as-is.
  }
}

/** Ensure git user.name/email match the instance identity. */
function ensureGitIdentity(instanceDir: string, instanceId: string): void {
  if (!hasOwnGitRepo(instanceDir)) {
    console.warn(`[Provision] ensureGitIdentity skipped — "${instanceDir}" has no own .git (would clobber host repo above).`);
    return;
  }
  const wantName = `instance/${instanceId}`;
  const wantEmail = `${instanceId}@agenteam.local`;
  try {
    const curName = execSync("git config user.name", {
      cwd: instanceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
    }).trim();
    const curEmail = execSync("git config user.email", {
      cwd: instanceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
    }).trim();
    if (curName === wantName && curEmail === wantEmail) return;
  } catch { /* config keys missing — set them below */ }

  execSync(`git config user.name "${wantName}"`, { cwd: instanceDir, stdio: "ignore" });
  execSync(`git config user.email "${wantEmail}"`, { cwd: instanceDir, stdio: "ignore" });
}

async function migrateToClone(instanceDir: string, instanceId: string, templateDir: string): Promise<void> {
  console.log(`[Provision] Migrating "${instanceId}" from worktree to independent clone (preserving runtime data)...`);

  // stash all local changes (tracked dirty + untracked) so nothing is lost
  let hasStash = false;
  try {
    const out = execSync("git stash push --include-untracked -m __migrate__", {
      cwd: instanceDir, encoding: "utf-8", timeout: 15_000,
    }).trim();
    hasStash = !out.includes("No local changes");
  } catch {}

  const tmpDir = `${instanceDir}.__migrate_tmp`;
  mkdirSync(tmpDir, { recursive: true });

  const preserved = collectPreservedPaths(instanceDir);
  for (const name of preserved) {
    try { renameSync(join(instanceDir, name), join(tmpDir, name)); } catch {}
  }

  // export stash as a patch so it survives the directory replacement
  let stashPatch: string | null = null;
  if (hasStash) {
    try {
      stashPatch = execSync("git stash show -p --binary stash@{0}", {
        cwd: instanceDir, encoding: "utf-8", timeout: 15_000,
      });
    } catch {}
  }

  cleanupWorktreeState(instanceDir, instanceId, templateDir);
  rmSync(instanceDir, { recursive: true, force: true });

  await createClone(instanceDir, instanceId, templateDir);

  for (const name of preserved) {
    if (existsSync(join(tmpDir, name))) {
      const target = join(instanceDir, name);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      try { renameSync(join(tmpDir, name), target); } catch {}
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });

  // restore stashed changes into the fresh clone
  if (stashPatch) {
    try {
      execSync("git apply --3way -", {
        cwd: instanceDir, input: stashPatch, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(`[Provision] Restored stashed local changes for "${instanceId}".`);
    } catch (err: any) {
      console.warn(`[Provision] Could not auto-apply stashed changes for "${instanceId}": ${err?.message || err}`);
    }
  }
}

/**
 * Install a pre-push hook that only allows pushing to evolve/* branches.
 * Idempotent: overwrites on every call to keep the hook content up-to-date.
 */
function ensurePrePushHook(instanceDir: string): void {
  const hooksDir = join(instanceDir, ".git", "hooks");
  if (!existsSync(hooksDir)) return;  // not a git repo

  const hookPath = join(hooksDir, "pre-push");
  const hookContent = `#!/bin/sh
# Auto-installed by AgenTeam instance provisioning.
# Only allow pushing to evolve/* branches.
# Override: AGENTEAM_ALLOW_PROTECTED_PUSH=1 git push ...

if [ "$AGENTEAM_ALLOW_PROTECTED_PUSH" = "1" ]; then
  exit 0
fi

BLOCKED=0

while read _local_ref _local_sha remote_ref _remote_sha; do
  case "$remote_ref" in refs/tags/*) continue ;; esac
  branch="\${remote_ref#refs/heads/}"
  case "$branch" in
    evolve/*) ;;
    *)
      echo "\\033[1;31m\u274c BLOCKED:\\033[0m Push to branch '$branch' is not allowed from an AgenTeam instance." >&2
      echo "   Agents must push to evolve/* branches and use the MR workflow." >&2
      echo "   Override: AGENTEAM_ALLOW_PROTECTED_PUSH=1 git push ..." >&2
      BLOCKED=1
      ;;
  esac
done

exit $BLOCKED
`;

  try {
    writeFileSync(hookPath, hookContent, { encoding: "utf-8" });
    chmodSync(hookPath, 0o755);
  } catch (err: unknown) {
    console.warn(`[Provision] Failed to install pre-push hook: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 确保 git 工作区处于可编译状态（无合并冲突、无中断的 rebase）。
 *
 * 策略：
 *   - stash pop 冲突 → 逐文件 checkout --theirs（保留本地代码），reset 退出冲突态
 *   - merge 冲突 → abort merge，stash 本地改动 → pull → pop（冲突则同上处理）
 *   - 中断的 rebase → abort
 *   - 最后尝试 best-effort fast-forward pull 确保与上游同步
 */
function ensureCleanGitState(instanceDir: string): void {
  const gitDir = join(instanceDir, ".git");
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;

  // 1. 中断的 rebase → abort
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    console.log("[Provision] Aborting in-progress rebase...");
    try { execSync("git rebase --abort", { cwd: instanceDir, stdio: "ignore", timeout: 5_000 }); } catch {}
  }

  // 2. 检查未解决的冲突
  const unmerged = lsUnmerged(instanceDir);
  if (unmerged.length > 0) {
    const isMerge = existsSync(join(gitDir, "MERGE_HEAD"));

    if (isMerge) {
      // merge/pull 冲突 → abort 回到 merge 前状态，然后 stash→pull→pop 重新同步
      console.log(`[Provision] Merge conflict (${unmerged.length} file(s)), aborting and retrying pull...`);
      try { execSync("git merge --abort", { cwd: instanceDir, stdio: "ignore", timeout: 5_000 }); } catch {}
      pullWithStash(instanceDir);
    } else {
      // stash pop 冲突（无 MERGE_HEAD）→ 保留 theirs（stash 版本 = 本地代码）
      console.log(`[Provision] Stash-pop conflict (${unmerged.length} file(s)), resolving (keeping local code)...`);
      resolveConflictsKeepLocal(instanceDir, unmerged);
      // pop 失败时 stash 未被 drop，手动清理
      try { execSync("git stash drop", { cwd: instanceDir, stdio: "ignore", timeout: 5_000 }); } catch {}
    }
  }

  // 3. best-effort fast-forward 拉取上游
  pullBestEffort(instanceDir);
}

function lsUnmerged(cwd: string): string[] {
  try {
    const raw = execSync("git diff --name-only --diff-filter=U", {
      cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
    }).trim();
    return raw ? raw.split("\n") : [];
  } catch { return []; }
}

/**
 * 逐文件解决冲突：checkout --theirs（stash/本地版本），add 标记已解决，
 * 最后 reset 退出冲突态（index 恢复 HEAD，工作区保持不变）。
 */
function resolveConflictsKeepLocal(instanceDir: string, files: string[]): void {
  for (const f of files) {
    // --theirs = stash pop 场景中的本地代码
    try {
      execSync(`git checkout --theirs -- "${f}"`, { cwd: instanceDir, stdio: "ignore", timeout: 5_000 });
    } catch {
      try { execSync(`git checkout --ours -- "${f}"`, { cwd: instanceDir, stdio: "ignore", timeout: 5_000 }); } catch {}
    }
    try { execSync(`git add -- "${f}"`, { cwd: instanceDir, stdio: "ignore", timeout: 5_000 }); } catch {}
  }
  // reset index → HEAD，工作区保持不变，退出冲突态
  try { execSync("git reset", { cwd: instanceDir, stdio: "ignore", timeout: 5_000 }); } catch {}
  console.log(`[Provision] Resolved ${files.length} conflicted file(s).`);
}

/** stash 本地改动 → pull --ff-only → stash pop；pop 冲突则走 resolveConflictsKeepLocal */
function pullWithStash(instanceDir: string): void {
  let hasStash = false;
  try {
    const out = execSync('git stash push -u -m "provision-recovery"', {
      cwd: instanceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }).trim();
    hasStash = !out.includes("No local changes");
  } catch {}

  pullBestEffort(instanceDir);

  if (!hasStash) return;
  try {
    execSync("git stash pop", { cwd: instanceDir, stdio: "ignore", timeout: 10_000 });
  } catch {
    const conflicts = lsUnmerged(instanceDir);
    if (conflicts.length > 0) {
      resolveConflictsKeepLocal(instanceDir, conflicts);
      try { execSync("git stash drop", { cwd: instanceDir, stdio: "ignore", timeout: 5_000 }); } catch {}
    }
  }
}

/** 尝试 fast-forward 拉取上游，失败不阻塞启动 */
function pullBestEffort(instanceDir: string): void {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: instanceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
    }).trim();
    if (!branch || branch === "HEAD") return;
    execSync(`git pull --ff-only origin ${branch}`, {
      cwd: instanceDir, stdio: "ignore", timeout: 30_000,
    });
    console.log(`[Provision] Fast-forward pull completed (${branch}).`);
  } catch {
    // non-ff, detached HEAD, or network error — proceed with current HEAD
  }
}

function needsInstall(instanceDir: string): boolean {
  const nm = join(instanceDir, "node_modules");
  if (!existsSync(nm)) return true;
  const marker = join(nm, ".package-lock.json");
  return !existsSync(marker);
}

function ensureDeps(instanceDir: string, instanceId: string): void {
  if (!needsInstall(instanceDir)) return;
  console.log(`[Provision] Installing dependencies for "${instanceId}" ...`);
  try {
    execSync("pnpm install --frozen-lockfile", {
      cwd: instanceDir, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
  } catch (frozenErr: unknown) {
    const detail = extractExecError(frozenErr);
    console.warn(`[Provision] --frozen-lockfile failed for "${instanceId}": ${detail}`);
    console.log(`[Provision] Retrying with pnpm install (no frozen-lockfile) for "${instanceId}" ...`);
    try {
      execSync("pnpm install", {
        cwd: instanceDir, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      });
    } catch (fallbackErr: unknown) {
      const msg = extractExecError(fallbackErr);
      console.error(`[Provision] pnpm install failed for "${instanceId}": ${msg}`);
      throw new Error(`Failed to install dependencies for instance "${instanceId}": ${msg}`);
    }
  }
}

function extractExecError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as any;
  const stderr = e.stderr ? Buffer.isBuffer(e.stderr) ? e.stderr.toString().trim() : String(e.stderr).trim() : "";
  const stdout = e.stdout ? Buffer.isBuffer(e.stdout) ? e.stdout.toString().trim() : String(e.stdout).trim() : "";
  return stderr || stdout || e.message;
}

function collectPreservedPaths(_instanceDir: string): string[] {
  return ["team", "backups", "containers.list", "debug.log", "node_modules"];
}

/** Clean up old worktree registration in the template repo (migration only). */
function cleanupWorktreeState(instanceDir: string, instanceId: string, templateDir: string): void {
  try { execSync(`git worktree remove "${instanceDir}" --force`, { cwd: templateDir, stdio: "ignore" }); } catch {}
  try { execSync(`git branch -D "instance/${instanceId}"`, { cwd: templateDir, stdio: "ignore" }); } catch {}
}
