/**
 * SandboxManager — Docker 沙箱容器生命周期管理。
 *
 * team 维度一个长驻容器 agenteam-sbx-{teamId}，隔离模式由 pack.json
 * 的 sandbox.mode 字段声明（direct / headless / desktop）。
 *
 * 仅 Docker 模式下使用，Direct 模式下 isEnabled() === false，manager 不操作任何容器。
 *
 * 模块职责分工：
 *   - 本文件              → 单例生命周期、配置加载、ensureSandbox 编排、docker run args、容器注册清理
 *   - ./image-manager.ts  → 镜像存在性检查 / drift 检测 / rebuild（委托 pack-builder）
 *   - ./container-setup.ts → 容器启动后的幂等自愈（KEX/FUSE/umask/passwd/sudoers/SSH/git/SSHFS）
 *   - ./docker-cli.ts     → docker subprocess wrapper（runDocker）
 *
 * 镜像策略：
 *   - tag 格式：mc-sbx-pack-{packId}:latest（pack 级唯一，可预构建复用）
 *   - tag 由 manifest.id 推导，不再单独存储
 *
 * 容器策略：
 *   - 容器名：agenteam-sbx-{teamId}（team 级唯一）
 *   - teamId 从 manifest.json 读取
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, isAbsolute } from "node:path";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { getPackImageTag } from "../packs/pack-builder.js";
import { getPathManager } from "../fs/path-manager.js";
import { getSharedPaths } from "../fs/state-dir.js";
import { PortForwarder, type PortMapping } from "./port-forwarder.js";
import type { PackMount } from "../defaults/pack/pack-json.js";
import { type SandboxMode } from "../defaults/pack/pack-json.js";
import { getFSWatcher } from "../fs/watcher.js";
import type { WatchRegistration, ProvisioningPhase } from "../core/types.js";
import { runDocker } from "./docker-cli.js";
import { applyContainerSetup, mountSshfs } from "./container-setup.js";
import { imageDrifted, ensureImageExists } from "./image-manager.js";

export type { PortMapping };

// ──────────────────────────────────────────────────────────────────────────────
// 配置类型（对应 agenteam.json 的 sandbox 字段）
// ──────────────────────────────────────────────────────────────────────────────
export interface DockerRunOptions {
  shmSize?: string;
  seccomp?: string;
  capAdd?: string[];
  gpus?: string;
  extraArgs?: string[];
}

export interface SandboxConfig {
  mode: SandboxMode;
  sshKeyPath?: string;
  /** Host sshd port for SSHFS; populated by start.sh detect_sshd_port, defaults to 22. */
  sshPort?: number;
  hostGateway: boolean;
  mounts: PackMount[];
  ports: number[];
  dockerRun?: DockerRunOptions;
}

interface ResolvedConfig extends SandboxConfig {
  resolvedImage: string;
  packId?: string;
  teamId?: string;
}

const DEFAULT_DOCKER_RUN: DockerRunOptions = {
  shmSize: "1g",
  seccomp: "unconfined",
};

// Capabilities the framework always requires (FUSE/SSHFS needs SYS_ADMIN).
// Pack capAdd is additive on top of these — cannot remove them.
const REQUIRED_CAPS = ["SYS_ADMIN"];

const DEFAULT_CONFIG: SandboxConfig = {
  mode: "direct" as SandboxMode,
  sshPort: 22,
  hostGateway: true,
  mounts: [],
  ports: [],
};


/**
 * 探测 Docker daemon 是否支持 GPU（NVIDIA Container Runtime）。
 *
 * 结果在进程内缓存：首次探测后重复调用直接返回缓存值（GPU 运行时在进程
 * 生命周期内不会热加载/卸载，缓存安全）。
 *
 * 探测方式：`docker info --format '{{json .Runtimes}}'` → 是否列出 nvidia 运行时。
 * 比 `docker run --gpus` 测试更快更轻（不拉镜像，不启动容器），且对没 GPU 的
 * 机器零副作用。
 */
let _gpuSupportCache: boolean | null = null;
async function probeGpuSupport(): Promise<boolean> {
  if (_gpuSupportCache !== null) return _gpuSupportCache;
  try {
    const out = await runDocker(["info", "--format", "{{json .Runtimes}}"]);
    // out 形如 {"io.containerd.runc.v2":{...},"nvidia":{...},"runc":{...}}
    _gpuSupportCache = /"nvidia"\s*:/.test(out);
  } catch {
    _gpuSupportCache = false;
  }
  return _gpuSupportCache;
}

// ──────────────────────────────────────────────────────────────────────────────
// SandboxManager
// ──────────────────────────────────────────────────────────────────────────────
export class SandboxManager {
  private static _instance: SandboxManager | null = null;

  /** 已确认 running 状态的容器集合（软缓存，exec 失败时会被清除并重试） */
  private readonly _running = new Set<string>();
  /** Last toolchain install error (null = ok). Surface at LSP-use-site, not at sandbox setup. */
  private _toolchainInstallError: string | null = null;
  private _portForwarder: PortForwarder | null = null;

  /**
   * 并发保护锁：ensureSandbox() 进行中时的 Promise。
   * 多个 agent 同时初始化时，只有第一个真正执行 docker run/start，
   * 其余等待同一个 Promise 完成。
   */
  private _startingPromise: Promise<void> | null = null;
  private _mountsWatcher: WatchRegistration | null = null;

  private constructor(
    private readonly config: ResolvedConfig,
  ) {}

  // ── 单例初始化 ──────────────────────────────────────────────────────────────

  /**
   * 读取 agenteam.json（sandbox 配置）+ team/manifest.json（imageTag）
   * 完成单例初始化。可重复调用（每次重新读配置，适用于 loadPackToTeam 后 re-init）。
   */
  static async init(): Promise<SandboxManager> {
    // Dispose previous watcher if re-initializing
    SandboxManager._instance?._mountsWatcher?.dispose();

    const config = await SandboxManager._loadConfig();
    const mgr = new SandboxManager(config);
    SandboxManager._instance = mgr;

    // Watch mounts.json for changes → auto re-mount SSHFS
    if (mgr.isEnabled()) {
      const fsw = getFSWatcher();
      if (fsw) {
        mgr._mountsWatcher = fsw.watchFile(
          getPathManager().instance().mountsConfig(),
          () => {
            const name = mgr.getContainerName();
            if (mgr._running.has(name)) {
              mountSshfs(name, mgr.config.mode, mgr.config.sshPort).catch((e) =>
                console.warn("[SandboxManager] mounts.json change: re-mount failed", e),
              );
            }
          },
          { debounceMs: 500, ownerId: "sandbox-manager" },
        );
      }
    }

    return mgr;
  }

  static get(): SandboxManager | null {
    return SandboxManager._instance;
  }

  // ── 公共 API ────────────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.config.mode !== "direct";
  }

  getMode(): SandboxMode {
    return this.config.mode;
  }

  getContainerName(): string {
    return this.config.teamId ? `agenteam-sbx-${this.config.teamId}` : `agenteam-sbx`;
  }

  getResolvedImage(): string {
    return this.config.resolvedImage;
  }

  getProjectRoot(): string {
    return getPathManager().instance().root();
  }

  /**
   * Spawn a process inside the sandbox container, returning a raw ChildProcess
   * with stdio pipes the caller manages directly.
   *
   * Use for long-lived stdio servers (typescript-language-server, debug adapters,
   * interactive bridges) and shell sessions. For one-shot command execution
   * with capture-and-return semantics, prefer TerminalManager.exec().
   *
   * Throws when sandbox is disabled (direct mode) — caller must check isEnabled().
   */
  spawnInContainer(opts: {
    command: string;
    args?: string[];
    user: string;
    cwd?: string;
    /** Raw docker-exec env args (e.g. output of buildSandboxExecArgs). */
    envArgs?: string[];
    /** Default: ["pipe", "pipe", "pipe"]. */
    stdio?: StdioOptions;
  }): ChildProcess {
    if (!this.isEnabled()) {
      throw new Error("spawnInContainer called when sandbox is not enabled (direct mode)");
    }
    const name = this.getContainerName();
    const dockerArgs = ["exec", "-i", "--user", opts.user];
    if (opts.cwd) dockerArgs.push("--workdir", opts.cwd);
    if (opts.envArgs?.length) dockerArgs.push(...opts.envArgs);
    dockerArgs.push(name, opts.command, ...(opts.args ?? []));
    return spawn("docker", dockerArgs, {
      stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
    });
  }

  /**
   * 确保 team 沙箱容器正在运行。
   * - 容器已 running（缓存命中） → 直接返回
   * - 并发调用时：只有第一个真正执行，其余等待同一 Promise（防止并发 docker run 冲突）
   * - 容器存在但 stopped → docker start
   * - 容器不存在 → docker run -d
   * - 最多轮询 10s 等容器就绪
   */
  async ensureSandbox(onStatus?: (message: string, phase?: ProvisioningPhase) => void): Promise<void> {
    const name = this.getContainerName();

    // Re-read packId from manifest.json on every call — manifest.id can change
    // at runtime (pack swap via API / manual edit). If resolvedImage shifts,
    // drop the _running cache so _doEnsureSandbox runs drift check + rebuild.
    // Other config fields (mode/mounts/ports) remain init-time cached —
    // they're pack-level invariants refreshed via full instance restart only.
    const manifestPath = getPathManager().team().manifest();
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: unknown };
        const newPackId = typeof m.id === "string" ? m.id : undefined;
        if (newPackId && newPackId !== this.config.packId) {
          console.info(
            `[SandboxManager] packId refreshed from manifest: ${this.config.packId} → ${newPackId}`,
          );
          this.config.packId = newPackId;
          this.config.resolvedImage = getPackImageTag(newPackId);
          this._running.delete(name);
        }
      } catch { /* malformed manifest — keep cached values */ }
    }

    if (this._running.has(name)) return;

    // 并发保护：若已有进行中的启动 Promise，直接等它完成
    if (this._startingPromise) {
      await this._startingPromise;
      return;
    }

    this._startingPromise = this._doEnsureSandbox(name, onStatus).finally(() => {
      this._startingPromise = null;
    });
    await this._startingPromise;
  }

  private async _doEnsureSandbox(name: string, onStatus?: (message: string, phase?: ProvisioningPhase) => void): Promise<void> {
    onStatus?.("Checking container state...", "initializing_sandbox");
    const state = await this._inspectContainerState(name);

    // Image drift self-heal — applies to ANY existing container (running, exited,
    // created, paused). When the container's bound image ID differs from the
    // current resolvedImage tag, the container is wrong — pack changed, image
    // rebuilt, or clean-image'd. Keeping a drifted container (even running) only
    // preserves work in the wrong environment. rm + run is always correct.
    if (state && await imageDrifted(name, this.config.resolvedImage)) {
      onStatus?.("Container bound to stale image — recreating...", "creating_container");
      console.info(
        `[SandboxManager] Image drift detected for "${name}" (state=${state}); ` +
        `removing container to rebind to ${this.config.resolvedImage}.`,
      );
      this._running.delete(name);
      await runDocker(["rm", "-f", name]);
      // Fall through to the run path below.
    } else if (state === "running") {
      this._running.add(name);
      await applyContainerSetup(name, this.config);
      await this._ensureContainerToolchain(name);
      return;
    } else if (state === "exited" || state === "created" || state === "paused") {
      onStatus?.("Starting existing container...", "starting_container");
      await runDocker(["start", name]);
      await this._waitUntilReady(name);
      this._running.add(name);
      await applyContainerSetup(name, this.config);
      await this._ensureContainerToolchain(name);
      return;
    }

    await ensureImageExists(this.config.packId, this.config.resolvedImage, this.config.mode, onStatus);
    onStatus?.("Creating container...", "creating_container");
    // Every mode's Dockerfile CMD handles its own keep-alive:
    //   - headless/direct: CMD ["sleep", "infinity"]
    //   - desktop: CMD ["/usr/local/bin/start-desktop"] which boots the
    //     desktop stack (Xkasmvnc + xfce4) and ends with `exec sleep infinity`.
    //     start-desktop waits for /etc/passwd to gain SANDBOX_USER (written
    //     by applyContainerSetup below, concurrent with this CMD) before
    //     running `runuser`, so the UID race is handled inside the image.
    const runArgs = [
      "run", "-d", "--name", name,
      "--hostname", this.config.packId!,
      ...(await this._buildRunOptions()),
      ...this._buildVolumeArgs(),
      ...this._buildNetworkArgs(),
      // Locale environment — previously baked into Dockerfile ENV, now injected at container creation
      "-e", "LANG=zh_CN.UTF-8", "-e", "LC_ALL=zh_CN.UTF-8",
      this.config.resolvedImage,
    ];
    await runDocker(runArgs);
    await this._registerContainer(name);

    await this._waitUntilReady(name);
    this._running.add(name);
    await applyContainerSetup(name, this.config);
    await this._ensureContainerToolchain(name);
  }

  /**
   * Idempotent: install container TS toolchain (typescript-language-server, typescript, tsx) if any missing.
   *
   * Persisted in `/usr/local/lib/node_modules/` (overlay upper layer) — survives
   * container restart, lost only on `rm-containers`.
   *
   * Failure is **NOT fatal** — the toolchain is an enhancement, not a core
   * sandbox requirement (shell / fs / build all work without it). Failure is
   * recorded; ContainerLSPClient consults `getToolchainError()` and surfaces a
   * clear error at use-site (fail-at-use-site, not fail-at-setup).
   */
  private async _ensureContainerToolchain(name: string): Promise<void> {
    try {
      await runDocker([
        "exec", name, "sh", "-c",
        "(command -v typescript-language-server >/dev/null 2>&1 && command -v tsx >/dev/null 2>&1) || npm i -g --silent typescript-language-server typescript tsx",
      ]);
      this._toolchainInstallError = null;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this._toolchainInstallError = msg;
      console.warn(
        `[SandboxManager] container TS toolchain install failed in "${name}": ${msg}. ` +
        `LSP and tsx will fail at use-site; sandbox itself remains usable.`,
      );
    }
  }

  /**
   * Last container TS toolchain install error from `_ensureContainerToolchain`,
   * or null when the toolchain is ready. Consulted by ContainerLSPClient to
   * surface a clear error at use-site instead of an opaque "server crashed".
   */
  getToolchainError(): string | null {
    return this._toolchainInstallError;
  }

  /**
   * Quick check: is the resolved Docker image present in the local daemon?
   * Used by fs-bridge to distinguish "container restart" vs "image rebuild" in diagnostics.
   */
  async isImageAvailable(): Promise<boolean> {
    try {
      await runDocker(["image", "inspect", "--format", "{{.Id}}", this.config.resolvedImage]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 在执行 docker exec 失败后调用，清除缓存并重新确保容器可用。
   * 防止容器被外部 stop 后 _running 缓存过期导致持续失败。
   */
  async invalidateAndRestart(onStatus?: (message: string, phase?: ProvisioningPhase) => void): Promise<void> {
    const name = this.getContainerName();
    this._running.delete(name);
    const statusCb = onStatus ?? ((msg: string) => console.warn(`[SandboxManager:recovery] ${msg}`));
    await this.ensureSandbox(statusCb);
  }

  /**
   * 应用端口映射：确保容器已运行，然后通过 socat 进程动态转发端口。
   * 由 FSWatcher → IPC 回调链触发，不需要重建容器。
   */
  async applyPortMappings(mappings: PortMapping[]): Promise<void> {
    if (!this.isEnabled()) return;
    await this.ensureSandbox();
    const name = this.getContainerName();
    if (!this._portForwarder) {
      this._portForwarder = new PortForwarder(name);
    }
    await this._portForwarder.syncForwards(mappings);
  }

  /**
   * 停止所有已知容器（进程退出时调用）。不删除容器，保留状态以便下次复用。
   * 已升级为基于注册表，不只停内存缓存中的。
   */
  async stopAll(): Promise<void> {
    await this.stopAllRegistered();
  }

  /**
   * 停止注册表中所有容器（docker stop），忽略已停/不存在的。
   * 同时清空内存缓存。
   */
  async stopAllRegistered(): Promise<void> {
    this._mountsWatcher?.dispose();
    this._mountsWatcher = null;
    this._portForwarder?.stopAll();
    this._portForwarder = null;
    const names = await this._readRegisteredContainers();
    this._running.clear();
    if (names.length === 0) return;
    await Promise.allSettled(names.map((n) => runDocker(["stop", n]).catch(() => {})));
  }

  /**
   * 强制删除注册表中所有容器（docker rm -f）。不删除镜像（镜像是 pack 级共享资源）。
   * 清空 containers.list。
   */
  async removeAllRegistered(): Promise<void> {
    this._portForwarder?.stopAll();
    this._portForwarder = null;
    const names = await this._readRegisteredContainers();
    this._running.clear();
    if (names.length > 0) {
      await Promise.allSettled(names.map((n) => runDocker(["rm", "-f", n]).catch(() => {})));
    }
    await this._writeRegisteredContainers([]);
  }

  // ── 私有实现 ────────────────────────────────────────────────────────────────

  private async _registerContainer(name: string): Promise<void> {
    const names = await this._readRegisteredContainers();
    if (names.includes(name)) return;
    names.push(name);
    await this._writeRegisteredContainers(names);
  }

  private async _readRegisteredContainers(): Promise<string[]> {
    const file = getPathManager().instance().containersRegistry();
    if (!existsSync(file)) return [];
    try {
      const text = await readFile(file, "utf-8");
      return text.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async _writeRegisteredContainers(containers: string[]): Promise<void> {
    const file = getPathManager().instance().containersRegistry();
    await writeFile(file, containers.join("\n") + (containers.length ? "\n" : ""), "utf-8");
  }

  /**
   * 读取配置：
   *   - agenteam.json → sshKeyPath
   *   - manifest.json   → sandbox 字段（pack.json 快照的容器参数）
   *   - manifest.id → 推导 imageTag
   */
  private static async _loadConfig(): Promise<ResolvedConfig> {
    const pm = getPathManager();
    // 1. 读 agenteam.json，取 sshKeyPath 与 sshPort
    let sshKeyPath: string | undefined;
    let sshPort: number | undefined;
    const cfgPath = getSharedPaths().agenteamConfig();
    if (existsSync(cfgPath)) {
      try {
        const raw = await readFile(cfgPath, "utf-8");
        const json = JSON.parse(raw) as Record<string, unknown>;
        const s = (json.sandbox ?? {}) as Record<string, unknown>;
        if (typeof s.sshKeyPath === "string" && s.sshKeyPath) {
          const raw = s.sshKeyPath;
          sshKeyPath = isAbsolute(raw) ? raw : join(getSharedPaths().root(), raw);
        }
        if (typeof s.sshPort === "number" && s.sshPort > 0) sshPort = s.sshPort;
      } catch (e) {
        console.error("[SandboxManager] Failed to parse agenteam.json:", e);
      }
    }

    // 2. 读 manifest.json，取 sandbox 快照（pack.json 配置）+ packId + teamId
    let packId: string | undefined;
    let teamId: string | undefined;
    let packSandbox: Record<string, unknown> = {};
    const manifestPath = pm.team().manifest();
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
        packId = typeof manifest.id === "string" ? manifest.id : undefined;
        teamId = typeof manifest.teamId === "string" ? manifest.teamId : undefined;
        packSandbox = ((manifest.sandbox ?? {}) as Record<string, unknown>);
      } catch { /* manifest 不存在或格式错误，忽略 */ }
    }

    // 3. 解析 mode：pack 声明，默认 headless
    const mode: SandboxMode = (packSandbox.mode as SandboxMode) || "headless";

    const base: SandboxConfig = {
      mode,
      sshKeyPath,
      sshPort: sshPort ?? DEFAULT_CONFIG.sshPort,
      hostGateway: (packSandbox.hostGateway as boolean | undefined) ?? DEFAULT_CONFIG.hostGateway,
      mounts: Array.isArray(packSandbox.mounts) ? packSandbox.mounts as PackMount[] : [],
      ports: Array.isArray(packSandbox.ports) ? packSandbox.ports as number[] : [],
      dockerRun: packSandbox.dockerRun as DockerRunOptions | undefined,
    };

    const resolvedImage = packId ? getPackImageTag(packId) : "mc-sbx-pack-default:latest";

    return { ...base, resolvedImage, packId, teamId };
  }

  /**
   * 检查容器状态，返回 docker inspect 的 Status 字符串，或 null（容器不存在）。
   */
  private async _inspectContainerState(name: string): Promise<string | null> {
    try {
      const out = await runDocker([
        "inspect", "--format", "{{.State.Status}}", name,
      ]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /** 构建 --network 参数，永远 bridge */
  private _buildNetworkArgs(): string[] {
    const args = ["--network", "bridge"];
    if (this.config.hostGateway) {
      args.push("--add-host", "host.docker.internal:host-gateway");
    }
    return args;
  }

  /** 构建 docker run 运行时安全/资源参数 */
  private async _buildRunOptions(): Promise<string[]> {
    const opts = this.config.dockerRun;
    const args: string[] = [];

    const seccomp = opts?.seccomp ?? DEFAULT_DOCKER_RUN.seccomp;
    if (seccomp) args.push("--security-opt", `seccomp=${seccomp}`);

    const shmSize = opts?.shmSize ?? DEFAULT_DOCKER_RUN.shmSize;
    if (shmSize) args.push("--shm-size", shmSize);

    // Framework-required caps + pack-additional caps (deduplicated)
    const caps = [...new Set([...REQUIRED_CAPS, ...(opts?.capAdd ?? [])])];
    for (const cap of caps) {
      args.push("--cap-add", cap);
    }

    // GPU passthrough: gracefully degrade when Docker has no NVIDIA runtime.
    // Without this check, `--gpus all` on a host missing nvidia-container-toolkit
    // makes `docker run` fail with a cryptic error and the whole sandbox never
    // comes up — forcing users to either install GPU support or edit config
    // files just to get a container. We probe once and skip with a warning.
    if (opts?.gpus) {
      const gpuAvailable = await probeGpuSupport();
      if (gpuAvailable) {
        args.push("--gpus", opts.gpus);
      } else {
        console.warn(
          `[SandboxManager] sandbox.dockerRun.gpus="${opts.gpus}" requested but ` +
          `Docker has no NVIDIA runtime — starting container without GPU passthrough. ` +
          `Install nvidia-container-toolkit on the host to enable GPUs.`,
        );
      }
    }

    if (opts?.extraArgs) {
      args.push(...opts.extraArgs);
    }

    // Expose the host username to the container so the image's entrypoint
    // (e.g. docker/desktop/start-desktop.sh) can run its long-running
    // processes under the same identity agents use for `docker exec`. Matches
    // the passwd entry written by container-setup.ts::configureContainerSystem;
    // when uid === 0 we leave SANDBOX_USER unset and let the entrypoint decide
    // its own default (e.g. start-desktop falls back to `node`).
    const uid = process.getuid?.() ?? 0;
    if (uid !== 0) {
      const uname = userInfo().username || `host${uid}`;
      args.push("-e", `SANDBOX_USER=${uname}`);
    }

    return args;
  }

  /** 轮询 docker exec echo ok，最多等待 10 s */
  private async _waitUntilReady(name: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await runDocker(["exec", name, "echo", "ok"]);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`[SandboxManager] Container ${name} did not become ready within ${timeoutMs}ms`);
  }

  /**
   * 构建挂载参数。
   *
   * 策略：
   *   - 项目根整体以读写挂入容器（同路径映射，绝对路径不变）
   *   - node_modules/ 用 tmpfs 遮盖（容器有自己的 node 环境）
   *   - sshKeyPath：不再作为 bind mount 处理，改由 _setupSharedSshHome 用
   *     `docker cp` 放到 SSH_KEY_DIR。这样 SSH_KEY_DIR 路径变更不需要重建容器。
   *   - /dev/fuse device for SSHFS mounts
   *   - mounts.json read-only bind for startup script
   */
  private _buildVolumeArgs(): string[] {
    const root = getPathManager().instance().root();
    const args = [
      "-v", `${root}:${root}:rw`,
      "--mount", `type=tmpfs,destination=${root}/node_modules`,
    ];

    // FUSE device for SSHFS mounts inside container
    args.push("--device", "/dev/fuse");

    return args;
  }

}

/** 便捷访问器，供其他模块获取单例 */
export function getSandboxManager(): SandboxManager | null {
  return SandboxManager.get();
}
