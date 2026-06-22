// @desc Poll remote for updates, auto-sync, and wake admin after restart
import type { PluginSource } from "#src/capability/plugin/types.js";
import type { SelfEvent, AgentContext } from "#src/core/types.js";
import { getTerminalManager } from "#src/terminal/manager.js";
import { detectCurrentBranch } from "#src/git-common/git-utils.js";
import { checkRemoteHead } from "../lib/evolve-pr.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";

const POLL_INTERVAL_MS = 10_000;

function git(args: string[], opts?: { cwd?: string; timeout?: number }): string {
  return getTerminalManager().execSync("git", args, opts);
}

/**
 * 同步远程代码，优先保远程改动。
 * 策略：stash 本地改动（含 untracked）→ pull（fast-forward 远程）→ pop 本地改动
 * 冲突只会出现在 pop 阶段，此时远程改动已经安全落地，
 * 交给模型处理 pop 冲突不会丢失远程代码。
 *
 * 关键：stash 必须用 `-u`（--include-untracked）。否则 untracked 的新文件
 * （如 agent 新写的 changelog）留在工作区，会让 fast-forward 因同路径冲突
 * 报 "would be overwritten by checkout"，整个同步流程前功尽弃。
 */
function trySync(root: string, branch: string): string {
  const target = `origin/${branch}`;
  // 1. stash 本地未提交的改动（含 untracked，见上方注释）
  let hasStash = false;
  try {
    const stashOut = git(["stash", "push", "-u", "-m", "auto-sync-stash"], { cwd: root, timeout: 10_000 });
    hasStash = !stashOut.includes("No local changes");
  } catch (err: any) {
    // stash 失败（无改动或 git 异常），记录后继续同步
    console.warn("[system_event_listener] stash failed:", err?.message || err);
  }

  // 2. pull 远程（此时工作区干净，应该是 fast-forward）
  let pullResult: string;
  try {
    pullResult = git(["pull", "--ff-only", "origin", branch], { cwd: root, timeout: 30_000 });
  } catch (err: any) {
    // pull 失败（不是 fast-forward），尝试 rebase
    try {
      pullResult = git(["rebase", target], { cwd: root, timeout: 30_000 });
    } catch (rebaseErr: any) {
      try { git(["rebase", "--abort"], { cwd: root }); } catch {}
      // 恢复 stash
      if (hasStash) { try { git(["stash", "pop"], { cwd: root }); } catch {} }
      const stderr = rebaseErr?.stderr?.toString() || rebaseErr?.message || String(rebaseErr);
      return `自动同步到 ${target} 失败，请手动处理后执行 restart_instance。\n\n错误信息:\n${stderr}`;
    }
  }

  // 3. pop stash（冲突只会在这里出现，远程改动已安全落地）
  let popNote = "";
  if (hasStash) {
    try {
      git(["stash", "pop"], { cwd: root, timeout: 10_000 });
    } catch {
      popNote = "\n\n⚠️ 本地改动（stash）与远程有冲突，请手动执行 `git stash pop` 解决。远程代码已安全同步。";
    }
  }

  return `代码已同步到 ${target}。\n${pullResult}${popNote}\n\n请执行 restart_instance 重启实例以应用新代码。`;
}

export default function create(ctx: AgentContext): PluginSource {
  const emit = (event: SelfEvent) => ctx.eventBus.emitToSelf(event);
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastKnownHead: string | null = null;
  let pendingEvent: SelfEvent | null = null;

  function allAgentsIdle(): boolean {
    for (const id of ctx.teamBoard.agentIds()) {
      if (ctx.teamBoard.get(id, TEAMBOARD_KEYS.RUNNING) === true) return false;
    }
    return true;
  }

  function tryFlushPending(): void {
    if (pendingEvent && allAgentsIdle()) {
      emit(pendingEvent);
      pendingEvent = null;
    }
  }

  function enqueueOrEmit(event: SelfEvent): void {
    if (allAgentsIdle()) {
      emit(event);
    } else {
      pendingEvent = event;
    }
  }

  function poll(): void {
    tryFlushPending();

    const root = ctx.pathManager.root();
    try {
      git(["fetch", "origin", "--quiet"], { cwd: root, timeout: 30_000 });
    } catch {
      return;
    }

    const branch = detectCurrentBranch(root);

    if (lastKnownHead === null) {
      try {
        lastKnownHead = git(["rev-parse", `origin/${branch}`], { cwd: root, timeout: 5_000 });
      } catch { return; }

      let localHead: string;
      try {
        localHead = git(["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 });
      } catch { return; }

      if (localHead === lastKnownHead) return;

      const syncResult = trySync(root, branch);

      let newLocalHead: string;
      try {
        newLocalHead = git(["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 });
      } catch { return; }

      if (newLocalHead === lastKnownHead) return;

      let commits: string;
      try {
        commits = git(["log", "--oneline", `${localHead}..${lastKnownHead}`], { cwd: root });
      } catch { return; }

      enqueueOrEmit({
        source: "system_event_listener",
        type: "rebase_notice",
        payload: { content: `[System] 主仓库 ${branch} 分支有未同步的提交:\n${commits}\n\n${syncResult}` },
        ts: Date.now(),
        handoff: "turn",
      });
      return;
    }

    const result = checkRemoteHead(root, branch, lastKnownHead);
    if (!result) return;

    lastKnownHead = result.newHead;
    const syncResult = trySync(root, branch);
    enqueueOrEmit({
      source: "system_event_listener",
      type: "rebase_notice",
      payload: { content: `[System] 主仓库 ${branch} 分支有新提交:\n${result.commits}\n\n${syncResult}` },
      ts: Date.now(),
      handoff: "turn",
    });
  }

  return {
    name: "system_event_listener",

    start() {
      poll();
      timer = setInterval(poll, POLL_INTERVAL_MS);

      unsubscribe = ctx.eventBus.observe((event) => {
        if (event.type === "instance_restarted") {
          enqueueOrEmit({
            source: "system_event_listener",
            type: "restarted_success",
            payload: {
              content: "[System] 实例已重启完成，新代码已生效。你可以继续工作。",
            },
            ts: Date.now(),
            handoff: "turn",
          });
        }
      });
    },

    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
