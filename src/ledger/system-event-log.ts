/** Per-session "headless" event sink —— 对齐 agenteam ref `session/system-event-log.ts`。
 *
 *  ref 那边因为单进程一棵 EventBus，整个 sessionsRoot 共享一份
 *  `global-events.jsonl`；我们这边每个 sid 独立 EventBus，所以落到
 *  `<sid>/global-events.jsonl`，跟 logger / blackboard 一样 per-session 隔离。
 *
 *  收的是 EventBus 上**没有 owner**的事件 —— 既不属于某个 agent（emitterId
 *  null），又不指向某个 agent（event.to null）。当前已知的入口：
 *    - `agent_added` / `agent_removed`            （Scheduler.start onChange）
 *    - `default_dir_changed`                       （SessionManager.setDefaultDir）
 *    - `partial_boundary` / `compact_boundary`     （context-window/summary-compaction）
 *
 *  和 `EventLedger` 是两条独立的轨：ledger 是某个 agent 的对话 WAL（喂 LLM），
 *  这里是 session 级广播 WAL（喂 UI / 监控 / debug 工具）。**不**走 ledger
 *  blob / pointer 那一套压缩，纯 append JSONL —— 体量本来就小。 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Event } from "../core/types";

interface EventBusObservable {
  observe(handler: (event: Event, emitterId?: string) => void): () => void;
}

/** 挂 observer，返回 unsub。**同步**写盘 —— 跟 `EventLedger.append` 同步性
 *  对齐，调用方 publish 完即可认为已落盘，不必再等 microtask。
 *
 *  防"墓碑复活"：sm.delete 走 `close → dispose → rmSync(<sid>/)`，
 *  理论上 dispose 第一步就 unsub 这个 observer，但 fs.watch debounce
 *  setTimeout / event-bus 里的 in-flight 派发都可能让某条 publish 漏到
 *  unsub 之后。一旦漏到，`mkdirSync(dirname, recursive)` 会把刚被 rm
 *  的 `<sid>/` 整个目录复活回来 —— 这是"删除后 sessions list 空但目录
 *  还在 + 多出 1 行 agent_removed"的根因。
 *
 *  保底：写盘前 `existsSync(parentOfFile)` 即 `<sid>/`。session 已被
 *  外部 rm 掉了就**不**复活；session 还在就照常 mkdir+append（兼容
 *  正常的 first-write 场景）。 */
export function bindSystemEventLog(
  filePath: string,
  eventBus: EventBusObservable,
): () => void {
  const sessionRoot = dirname(filePath);
  let disposed = false;
  let dirEnsured = false;

  const unsub = eventBus.observe((event, emitterId) => {
    if (disposed) return;
    if (emitterId != null) return;
    if (event.to != null) return;
    if (event.type.startsWith("stream:")) return;

    // session 目录已被 rm（sm.delete 后期 / 外部清理）—— 别再用 mkdir
    // 复活墓碑。observer 已经事实上脱离 session 生命周期，跳过即可。
    if (!existsSync(sessionRoot)) return;

    if (!dirEnsured) {
      mkdirSync(sessionRoot, { recursive: true });
      dirEnsured = true;
    }
    const { block, isBlocked, blockReason, ...persisted } = event;
    void block;
    void isBlocked;
    void blockReason;
    appendFileSync(filePath, JSON.stringify(persisted) + "\n", "utf-8");
  });

  return () => {
    disposed = true;
    unsub();
  };
}
