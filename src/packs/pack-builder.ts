/**
 * pack-builder — Pack 环境预构建（Docker 镜像构建 & Direct 模式宿主机安装）。
 *
 * 职责边界：
 *   - buildPackDocker   构建含 setup.sh 的完整沙箱镜像（mc-sbx-pack-{packId}:latest） *   - buildPackDirect   在宿主机执行 setup.sh，写 .built 标记
 *   - getPackImageTag   统一的镜像命名规则
 *   - isPackBuilt       判断 pack 是否已构建（Docker 检查镜像 / Direct 检查 .built 文件）
 *
 * 与 sandbox/manager.ts 的分工：
 *   - pack-builder：构建时关注点（镜像制作、宿主机环境安装）
 *   - sandbox/manager：运行时关注点（容器生命周期、exec 参数、volume 挂载）
 */

import { readFile, writeFile, rm, mkdtemp, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

/** Pack 内 Dockerfile 的约定文件名 */
const PACK_DOCKERFILE = "Dockerfile";

import type { SandboxMode } from "../defaults/pack/pack-json.js";

/** 根据 sandbox mode 返回内置 Dockerfile 路径（相对于项目根） */
function getDockerfilePath(mode: SandboxMode): string {
  switch (mode) {
    case "desktop": return "docker/desktop/Dockerfile";
    case "headless":
    default: return "docker/headless/Dockerfile";
  }
}


// ──────────────────────────────────────────────────────────────────────────────
// 辅助：运行 docker 命令
// ──────────────────────────────────────────────────────────────────────────────

/** 执行 docker 子命令，返回 stdout（或抛出） */
function runDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker ${args[0]} failed (code ${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

/** 执行 docker 子命令，stdout/stderr 实时透传到终端（供 build / run 等长操作使用） */
function runDockerLive(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) console.log(`[docker] ${line}`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) console.log(`[docker] ${line}`);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker ${args[0]} failed (code ${code})`));
    });
    child.on("error", reject);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 公共工具
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 返回 pack 对应的 Docker 镜像 tag。
 * 使用 pack 级别的确定性命名，确保同一 pack 的镜像可被复用与预构建。
 */
export function getPackImageTag(packId: string): string {
  return `mc-sbx-pack-${packId}:latest`;
}

/**
 * 返回 pack 镜像的本地归档路径（packs/{packId}/image.tar）。
 * 构建完成后 save 到此路径，下次 isPackBuilt 检测到有此文件时自动 load，
 * 无需重新构建（换机器、Docker daemon 重装均可复用）。
 */
export function getPackImageTarPath(packDir: string): string {
  return join(packDir, "image.tar");
}

/**
 * 判断 pack 是否已完成构建。
 * - Docker 模式：
 *   1. 检查本地 daemon 是否有镜像（最快）
 *   2. 若 daemon 没有但 packs/{packId}/image.tar 存在 → 自动 docker load，返回 true
 *   3. 两者都没有 → 返回 false，触发重新构建
 * - Direct 模式：检查 {packDir}/.built 标记文件是否存在
 */
export async function isPackBuilt(packDir: string, packId: string, dockerEnabled: boolean): Promise<boolean> {
  if (dockerEnabled) {
    const tag = getPackImageTag(packId);
    // 先检查 daemon
    try {
      await runDocker(["image", "inspect", "--format", "{{.Id}}", tag]);
      return true;
    } catch { /* 镜像不在 daemon 里，继续检查 tar */ }

    // 检查本地 tar 文件，存在则 load 进 daemon
    const tarPath = getPackImageTarPath(packDir);
    if (existsSync(tarPath)) {
      console.log(`[PackBuilder] Image not in daemon, loading from ${tarPath}...`);
      await runDockerLive(["load", "-i", tarPath]);
      console.log(`[PackBuilder] Image loaded: ${tag}`);
      return true;
    }

    return false;
  } else {
    return existsSync(join(packDir, ".built"));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Docker 模式构建
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 为 packId 构建完整沙箱 Docker 镜像（mc-sbx-pack-{packId}:latest）。
 *
 * 不产生中间 builtin 镜像——直接将内置 Dockerfile 和 pack 自定义内容拼合为一个
 * Dockerfile 构建。Docker 层缓存自然复用不变的基础层，无需单独管理 builtin 镜像生命周期。
 *
 * 构建流程：
 *   1. 拼合 Dockerfile：内置（按 mode 选 headless/desktop）+ pack Dockerfile 追加内容
 *   2. 若 pack 含 startup-scripts/setup.sh → 再叠一层 RUN 烘进镜像
 *   构建完成后 docker save 到 packs/{packId}/image.tar，供换机器时 load 复用。
 *
 * @param packDir      pack 来源目录（packs/{packId}/）
 * @param packId       pack 唯一 ID
 * @param instanceRoot Instance 根目录（用于定位内置 Dockerfile）
 * @param mode         沙箱模式（headless / desktop），默认 headless
 * @returns            最终镜像 tag
 */
export async function buildPackDocker(
  packDir: string,
  packId: string,
  instanceRoot: string,
  mode: SandboxMode = "headless",
): Promise<string> {
  const finalTag = getPackImageTag(packId);
  const baseTag = `mc-sbx-pack-${packId}-base:latest`;

  // ── 阶段一：拼合 Dockerfile（内置基础 + pack 自定义）────────────────────────
  const builtinDockerfile = join(instanceRoot, getDockerfilePath(mode));
  if (!existsSync(builtinDockerfile)) {
    throw new Error(`[PackBuilder] Built-in Dockerfile not found: ${builtinDockerfile}`);
  }
  const builtinContent = await readFile(builtinDockerfile, "utf-8");

  const packDockerfile = join(packDir, PACK_DOCKERFILE);
  const tmpCtx = await mkdtemp(join(tmpdir(), "mc-pack-base-"));
  try {
    // Build context directory — all files end up here
    const ctxDir = join(tmpCtx, "ctx");

    if (existsSync(packDockerfile)) {
      // Has pack Dockerfile → pack dir is the base context (COPY paths work as-is),
      // then copy built-in sibling files (mount-sshfs.sh, start-desktop.sh) into it
      await cp(packDir, ctxDir, { recursive: true });
      await cp(dirname(builtinDockerfile), ctxDir, {
        recursive: true,
        filter: (src) => !src.endsWith("Dockerfile"),  // don't overwrite — we write merged below
      });

      // Merge: built-in content + pack additions (strip pack's FROM line)
      const packContent = await readFile(packDockerfile, "utf-8");
      const packAdditions = packContent.replace(/^FROM\s+.*\n?/m, "");

      const merged = builtinContent.trimEnd() + "\n\n"
        + `# ── Pack customization (${packId}) ────────────────────────────────────\n`
        + packAdditions;

      await writeFile(join(ctxDir, "Dockerfile"), merged);

      console.log(`[PackBuilder] Building ${mode} + pack merge image ${baseTag}...`);
    } else {
      // No pack Dockerfile → built-in dir is the context (has Dockerfile + sibling sh files)
      await cp(dirname(builtinDockerfile), ctxDir, { recursive: true });
      console.log(`[PackBuilder] Building ${mode} image ${baseTag} (no pack Dockerfile)...`);
    }

    await runDockerLive(["build", "-t", baseTag, ctxDir]);
  } finally {
    await rm(tmpCtx, { recursive: true, force: true }).catch(() => {});
  }

  // ── 阶段二：扩展镜像（setup.sh）─────────────────────────────────────────
  const setupScript = join(packDir, "startup-scripts", "setup.sh");
  const hasSetup = existsSync(setupScript);

  if (hasSetup) {
    const tmpBuildDir = await mkdtemp(join(tmpdir(), "mc-pack-build-"));
    try {
      await cp(join(packDir, "startup-scripts"), join(tmpBuildDir, "startup-scripts"), { recursive: true });
      const lines = [
        `FROM ${baseTag}`,
        "",
        "COPY startup-scripts/ /tmp/startup/",
        "RUN sh /tmp/startup/setup.sh && rm -rf /tmp/startup",
      ];
      await writeFile(join(tmpBuildDir, "Dockerfile"), lines.join("\n") + "\n");
      console.log(`[PackBuilder] Building final image ${finalTag} (with setup.sh)...`);
      await runDockerLive(["build", "-t", finalTag, tmpBuildDir]);
      console.log(`[PackBuilder] Image ${finalTag} built successfully.`);
    } finally {
      await rm(tmpBuildDir, { recursive: true, force: true }).catch(() => {});
      runDocker(["rmi", baseTag]).catch(() => {});
    }
  } else {
    await runDockerLive(["tag", baseTag, finalTag]);
    runDocker(["rmi", baseTag]).catch(() => {});
    console.log(`[PackBuilder] Image ${finalTag} built (no setup.sh).`);
  }

  // 将最终镜像保存为 tar，供换机器或 daemon 重装时直接 load
  const tarPath = getPackImageTarPath(packDir);
  console.log(`[PackBuilder] Saving image to ${tarPath}...`);
  await runDockerLive(["save", "-o", tarPath, finalTag]);
  console.log(`[PackBuilder] Image saved.`);

  return finalTag;
}

/** 运行 shell 脚本文件，stdout/stderr 实时透传 */
function runScript(scriptPath: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath], {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bash ${scriptPath} failed (exit code ${code})`));
    });
    child.on("error", reject);
  });
}
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Direct 模式 pack 构建：在宿主机执行 startup-scripts/setup.sh（如存在），
 * 然后写 {packDir}/.built 标记文件，供 team load 判断是否跳过构建。
 *
 * 注：better-sqlite3 不在此处安装——它依赖 team 目录，在 team load 的
 *     ensureTeamEnvironment() 阶段完成（Direct 模式唯一的运行时依赖安装）。
 */
export async function buildPackDirect(packDir: string): Promise<void> {
  const setupScript = join(packDir, "startup-scripts", "setup.sh");

  if (existsSync(setupScript)) {
    console.log("[PackBuilder] Running startup-scripts/setup.sh on host...");
    try {
      await runScript(setupScript, packDir);
      console.log("[PackBuilder] setup.sh completed.");
    } catch (err: unknown) {
      throw new Error(`[PackBuilder] setup.sh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log("[PackBuilder] No startup-scripts/setup.sh found, skipping.");
  }

  // 写 .built 标记（gitignore）
  await writeFile(
    join(packDir, ".built"),
    JSON.stringify({ builtAt: new Date().toISOString(), mode: "direct" }, null, 2) + "\n",
    "utf-8",
  );
  console.log("[PackBuilder] .built marker written.");
}

// ──────────────────────────────────────────────────────────────────────────────

