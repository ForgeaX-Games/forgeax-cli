/** AgentKitReloadCoordinator —— per-session hot-reload dispatcher.
 *
 *  Two surfaces share the same trigger infra（fs.watch + per-batch hash
 *  poll）：
 *
 *    1. **Kit hot-reload**（tools / slots / plugins under `kits/`）
 *       - fs.watch on shared 3 layers（builtin / user / session）+
 *         per-agent watch on agent-local `kits/`
 *       - reload 走 `BaseAgent.reloadKitKind(kind)` → loader._loadInternal
 *         → registry.replaceStatic（whole-kit override + ref-equality diff）。
 *
 *    2. **ScriptAgent src/index.ts hot-reload + hot-create + post-shutdown
 *        revival**
 *       - **polling-only**（`flushReloads`, 每个 ConsciousAgent tool batch
 *         之后 caller 调一次）via `scanScriptSrc()`。
 *       - fs.watch recursive 在 Linux ext4 上对 `O_TRUNC+write+close`
 *         模式（admin `write_file` 等）会静默丢事件，所以这一路只能 poll。
 *
 *  文件变更通过 combined hash（entry + recorded deps + sibling
 *  `condition.ts`）验证后再触发 reload，免得 touch/atime 触发假 reload。
 *
 *  Ported from agenteam-os-ref/src/loaders/agent-reload-coordinator.ts；
 *  forgeax 适配：3 共享层（builtin/user/session）+ per-agent 一层，
 *  agentId 改 agentPath，`pm.agent` 调用换成 `pm.session(sid).agent(path)`。 */

import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FSWatcherAPI, PathManagerAPI, WatchRegistration } from "../fs/types";
import type { BaseAgent } from "../core/base-agent";
import { SCRIPT_ENTRY_SEGMENTS } from "../core/script-agent";
import type { KitKind } from "./types";
import {
  computeFileHash,
  invalidateHash,
  shortHash,
  getEntryDeps,
  getDepsForFile,
} from "./resolve-hook";

const VALID_KINDS: ReadonlySet<KitKind> = new Set(["tools", "slots", "plugins"]);
const OWNER_PREFIX = "kit-reload-coordinator";

export class AgentKitReloadCoordinator {
  /** Running agents tracked for hot-reload. `<agentPath>` is the key. */
  private agents = new Map<string, BaseAgent>();
  private watchRegs: WatchRegistration[] = [];
  /** Snapshot map for poll-based scan: file abs path → combined hash. */
  private flushSnapshots = new Map<string, string>();
  /** Shared-dir 3 watch 是否已起 —— lazy 触发，避免纯容器 Session 也烧
   *  3 个 fs.watch slot。Ref 把这一步放在 scheduler.start() 一次性起；
   *  forgeax coordinator 属于 Session，registerAgent 自然是 attachAgent
   *  fires 进来的，所以借第一次 register 做 lazy boot。 */
  private _sharedWatching = false;

  constructor(
    private readonly sid: string,
    private readonly fsWatcher: FSWatcherAPI,
    private readonly pm: PathManagerAPI,
    /** Tree-wide agentPath iterator —— scanScriptSrc 用。返回 tree 里所有节点
     *  （含未 run 的 / 新建的 / shutdown 但 tree 还在的），让 polling 也覆盖
     *  hot-create / post-shutdown revival 路径。 */
    private readonly getAllAgentPaths: () => Iterable<string>,
    /** scheduler-injected hook —— 真正持 lifecycleLock 干 restart 的角色。
     *  返回 true = 处理了（可以推进 baseline）；false = 当前 busy，请下一次
     *  polling 再来。caller MUST 在 false 时**不**推进 baseline。 */
    private readonly scriptSrcChanged: (agentPath: string) => Promise<boolean>,
  ) {}

  // ─── Public agent registration ────────────────────────────────────────────

  registerAgent(agent: BaseAgent): void {
    if (!this._sharedWatching) {
      this.startWatching();
      this._sharedWatching = true;
    }
    this.agents.set(agent.agentPath, agent);
    this.watchAgentKits(agent.agentPath);

    // 立即基线 ScriptAgent src/index.ts —— 不然 registerAgent 后第一次
    // flushReloads 看到 prev=undefined 会触发一次 spurious reload。对 hot-
    // create agent（src 刚写完立刻又编辑）也保护一拍。
    const srcPath = join(
      this.pm.session(this.sid).agent(agent.agentPath).root(),
      ...SCRIPT_ENTRY_SEGMENTS,
    );
    if (existsSync(srcPath)) {
      invalidateHash(srcPath);
      this.flushSnapshots.set(srcPath, computeFileHash(srcPath));
    }
  }

  unregisterAgent(agentPath: string): void {
    this.agents.delete(agentPath);
    this.fsWatcher.unregisterOwner(`${OWNER_PREFIX}:${this.sid}:${agentPath}`);
    // NOTE: 故意**不**删 src/ baseline。crash → unregister → next scan 看到
    // prev=undefined → trigger hot-create → 再 crash → 死循环。保留 baseline
    // 让 scan 看到 prev===hash → no trigger。用户真改 src → hash 变 → 走正
    // 常 revival 路径。registerAgent 重新 set baseline。stale baseline
    // 对那些 doRemove 的节点不影响 —— polling 走 getAllAgentPaths() 不会枚
    // 举到。
  }

  // ─── Public lifecycle ─────────────────────────────────────────────────────

  startWatching(): void {
    // 3 共享层 dir watch（builtin / user / session）；agent layer 在
    // watchAgentKits 内 per-agent 加。**fs.watch 在不存在的目录上会 throw
    // ENOENT**（node + bun 都是），所以先 mkdir -p 兜底 —— 即使 4 层都空也
    // 让 inotify slot 真起得来，后续 add file 才能触发 reload。builtin 在
    // source tree 里通常有 README，不需要 mkdir，但保险起见统一处理。
    const sharedDirs = [
      this.pm.builtin().resourceDir("kits"),
      this.pm.user().resourceDir("kits"),
      this.pm.session(this.sid).resourceDir("kits"),
    ];
    for (const dir of sharedDirs) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* permissions / readonly */ }
      const reg = this.fsWatcher.watchDir(
        dir,
        (event) => this.onSharedKitFileChanged(dir, event.path),
        { ownerId: `${OWNER_PREFIX}:${this.sid}:shared`, debounceMs: 500 },
      );
      this.watchRegs.push(reg);
    }
  }

  stopWatching(): void {
    for (const reg of this.watchRegs) reg.dispose();
    this.watchRegs = [];
    this.fsWatcher.unregisterOwner(`${OWNER_PREFIX}:${this.sid}:shared`);
    for (const agentPath of this.agents.keys()) {
      this.fsWatcher.unregisterOwner(`${OWNER_PREFIX}:${this.sid}:${agentPath}`);
    }
    this.agents.clear();
    this.flushSnapshots.clear();
    this._sharedWatching = false;
  }

  // ─── Per-agent kit dir watch ──────────────────────────────────────────────

  private watchAgentKits(agentPath: string): void {
    const dir = this.pm.session(this.sid).agent(agentPath).resourceDir("kits");
    try { mkdirSync(dir, { recursive: true }); } catch { /* permissions / readonly */ }
    this.fsWatcher.watchDir(
      dir,
      (event) => this.onAgentKitFileChanged(agentPath, dir, event.path),
      { ownerId: `${OWNER_PREFIX}:${this.sid}:${agentPath}`, debounceMs: 500 },
    );
  }

  // ─── File event handlers ──────────────────────────────────────────────────

  /** subPath like `<kit>/<kind>/<name>.ts` or `<kit>/condition.ts`. */
  private static detectKindFromSubPath(subPath: string): KitKind | "all" | null {
    const parts = subPath.split(/[\\/]/);
    if (parts.length === 2 && parts[1] === "condition.ts") return "all";
    if (
      parts.length === 3 &&
      VALID_KINDS.has(parts[1] as KitKind) &&
      parts[2].endsWith(".ts")
    ) {
      return parts[1] as KitKind;
    }
    return null;
  }

  /** Resolve which kinds to reload for a fs change. subPath is relative to
   *  the kit dir root; absPath is absolute. Returns null = no-op. */
  private checkFileChanged(subPath: string, absPath: string): Set<KitKind> | null {
    const kind = AgentKitReloadCoordinator.detectKindFromSubPath(subPath);

    if (!kind) {
      // Not an entry / condition.ts. Check reverse dep index — if some
      // recorded entry depends on this file (via resolve-hook), reload its
      // kind. Otherwise ignore.
      const dependents = getDepsForFile(absPath);
      if (dependents.size === 0) return null;
      invalidateHash(absPath);
      const kinds = new Set<KitKind>();
      for (const entry of dependents) {
        const parts = entry.split(/[\\/]/);
        const kindIdx = parts.length - 2;
        if (kindIdx >= 0 && VALID_KINDS.has(parts[kindIdx] as KitKind)) {
          kinds.add(parts[kindIdx] as KitKind);
        }
      }
      return kinds.size > 0 ? kinds : new Set(VALID_KINDS);
    }

    // Direct entry / condition.ts change.
    invalidateHash(absPath);
    return kind === "all" ? new Set(VALID_KINDS) : new Set([kind]);
  }

  private onSharedKitFileChanged(absKitDir: string, subPath: string): void {
    const kinds = this.checkFileChanged(subPath, join(absKitDir, subPath));
    if (!kinds) return;
    for (const agent of this.agents.values()) {
      for (const kind of kinds) {
        agent
          .reloadKitKind(kind)
          .catch((err) =>
            process.stderr.write(
              `[reload-coordinator] reload failed: ${(err as Error)?.message ?? err}\n`,
            ),
          );
      }
    }
  }

  private onAgentKitFileChanged(agentPath: string, absKitDir: string, subPath: string): void {
    const kinds = this.checkFileChanged(subPath, join(absKitDir, subPath));
    if (!kinds) return;
    const agent = this.agents.get(agentPath);
    if (!agent) return;
    for (const kind of kinds) {
      agent
        .reloadKitKind(kind)
        .catch((err) =>
          process.stderr.write(
            `[reload-coordinator] reload failed for ${agentPath}: ${(err as Error)?.message ?? err}\n`,
          ),
        );
    }
  }

  // ─── Proactive flush（after each tool batch） ─────────────────────────────

  /** 扫所有 kit dir + 所有 agent src/index.ts。任何 combined hash 变化触发
   *  对应 kind 的 reload + scriptSrcChanged hook。返回是否触发过 reload。 */
  async flushReloads(): Promise<boolean> {
    const allPaths = [...this.agents.keys()];
    const dirs: Array<[string, string[]]> = [
      [this.pm.builtin().resourceDir("kits"), allPaths],
      [this.pm.user().resourceDir("kits"), allPaths],
      [this.pm.session(this.sid).resourceDir("kits"), allPaths],
      ...allPaths.map(
        (p) =>
          [
            this.pm.session(this.sid).agent(p).resourceDir("kits"),
            [p],
          ] as [string, string[]],
      ),
    ];

    const toReload = new Map<string, Set<KitKind>>();
    for (const [kitDir, agentPaths] of dirs) {
      let pkgs: import("node:fs").Dirent[];
      try {
        pkgs = await readdir(kitDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pkg of pkgs) {
        if (!pkg.isDirectory()) continue;
        for (const kind of VALID_KINDS) {
          let files: string[];
          try {
            files = (await readdir(join(kitDir, pkg.name, kind))).filter((f) =>
              f.endsWith(".ts"),
            );
          } catch {
            continue;
          }
          for (const f of files) {
            const p = join(kitDir, pkg.name, kind, f);
            invalidateHash(p);
            const eh = computeFileHash(p);

            // Combined hash includes deps recorded by resolve-hook during last
            // load + sibling condition.ts (it sits outside the import graph
            // but still affects the wrapper).
            const deps = getEntryDeps(p);
            let combined = eh;
            if (deps.size > 0) {
              const depHashes = [...deps]
                .sort()
                .map((d) => { invalidateHash(d); return computeFileHash(d); });
              combined = shortHash(eh + depHashes.join(""));
            }
            const condPath = join(kitDir, pkg.name, "condition.ts");
            invalidateHash(condPath);
            const condHash = computeFileHash(condPath);
            if (condHash !== "0") combined = shortHash(combined + condHash);

            const prev = this.flushSnapshots.get(p);
            if (prev === undefined) {
              // First encounter — establish baseline, no reload trigger.
              this.flushSnapshots.set(p, combined);
            } else if (prev !== combined) {
              this.flushSnapshots.set(p, combined);
              for (const path of agentPaths) {
                let set = toReload.get(path);
                if (!set) { set = new Set(); toReload.set(path, set); }
                set.add(kind);
              }
            }
          }
        }
      }
    }

    const srcChanged = await this.scanScriptSrc();

    if (toReload.size === 0) return srcChanged;
    const reloads: Promise<void>[] = [];
    for (const [path, kinds] of toReload) {
      const agent = this.agents.get(path);
      if (!agent) continue;
      for (const kind of kinds) reloads.push(agent.reloadKitKind(kind));
    }
    await Promise.all(reloads);
    return true;
  }

  /** ScriptAgent src/index.ts polling baseline scan. */
  private async scanScriptSrc(): Promise<boolean> {
    let triggered = false;
    for (const agentPath of this.getAllAgentPaths()) {
      const srcPath = join(
        this.pm.session(this.sid).agent(agentPath).root(),
        ...SCRIPT_ENTRY_SEGMENTS,
      );
      if (!existsSync(srcPath)) {
        if (this.flushSnapshots.has(srcPath)) this.flushSnapshots.delete(srcPath);
        continue;
      }
      invalidateHash(srcPath);
      const hash = computeFileHash(srcPath);
      const prev = this.flushSnapshots.get(srcPath);
      if (prev === hash) continue;

      try {
        const handled = await this.scriptSrcChanged(agentPath);
        if (handled) {
          this.flushSnapshots.set(srcPath, hash);
          triggered = true;
        }
        // !handled: 留住 baseline = prev，让下一拍 polling 再 detect。
      } catch (err: any) {
        process.stderr.write(
          `[reload-coordinator] src change handling failed for '${agentPath}': ${err?.message ?? err}\n`,
        );
        // 不要推进 baseline，让下次 retry。
      }
    }
    return triggered;
  }
}
