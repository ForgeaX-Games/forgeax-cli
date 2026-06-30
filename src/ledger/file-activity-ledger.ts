/** Per-session **file-activity** ledger —— SSOT for "who touched what".
 *
 *  落点：`<sid>/file-activity.jsonl`，每行一条 JSON。append-only，跟
 *  `system-event-log` / `EventLedger` 平行的第三条轨：
 *    - EventLedger        — per-agent 对话 WAL（喂 LLM context）
 *    - global-events.jsonl — session 级 headless 事件（agent_added 等）
 *    - file-activity.jsonl — agent **真实**触碰文件的 ledger（我们这条）
 *
 *  写入侧：`agent-fs-recorder.wrapAgentFs()` 包装 `AgentFsAPI` 的 mutation
 *  方法，在 `writeText / writeTextSync / appendTextSync / writeBinarySync /
 *  unlinkSync / renameSync / rmSync` 成功完成后同步 append 一条记录。
 *
 *  读取侧：
 *    - `GET /api/sessions/:sid/file-activity?path=&agent=&limit=` 查询
 *    - LLM slot `file-activity-recent` 喂 prompt
 *    - WS `file-activity` 事件让 UI 实时更新（recorder 同步发 EventBus）
 *
 *  与静态 manifest `produces[]` 的关系：本 ledger 是**事实**（实际写过哪些
 *  文件），produces 是**意图**（期望写哪些）。AgentsPanel 显示真实归属应
 *  以这个 ledger 为准；produces 退化为提示。Architecture-principles SSOT：
 *  归属只有一份权威来源，多个 agent 同时声称 produces 同一文件已不再造成
 *  归属歧义。 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Mutation kind. 每条 ledger 记录 op = 这一种。
 *  - write   覆盖写入（write_file 工具，writeText / writeTextSync / writeBinarySync）
 *  - append  追加写入（appendTextSync）
 *  - edit    单条 edit（edit_file 工具调到 writeText 后会被记成 write；这条
 *            目前由 caller 显式标注，留给 multi_edit 后续手动 record）
 *  - patch   patch 应用（apply_patch 工具）
 *  - delete  unlink / rm
 *  - rename  rename
 *
 *  recorder 默认从 method name 推 op；caller 想要更细可以走显式 record() 接口。 */
export type FileActivityOp =
  | "write"
  | "append"
  | "edit"
  | "patch"
  | "delete"
  | "rename";

export interface FileActivityRecord {
  /** Unix ms */
  ts: number;
  /** Agent path within the session tree (eg "iori", "iori/suzu", or "root"). */
  agentPath: string;
  /** Mutation kind —— 见 FileActivityOp。 */
  op: FileActivityOp;
  /** Absolute path of the affected file (post-`agent-fs.resolve`). */
  path: string;
  /** For rename only —— the source path. */
  fromPath?: string;
  /** Bytes written. Optional —— rename / delete 没意义。 */
  bytes?: number;
  /** True if the file did NOT exist immediately before this op. Lets UI
   *  distinguish "first write = create" from "subsequent overwrite". */
  isCreate?: boolean;
  /** Tool call id if recorder was invoked from a tool execute path. Optional. */
  toolCallId?: string;
}

/** Append + read ledger. Lifetime tied to Session (constructed in Session ctor). */
export class FileActivityLedger {
  private dirEnsured = false;
  private disposed = false;

  constructor(
    private readonly sessionRoot: string,
    private readonly filePath: string,
  ) {}

  /** Synchronous append —— 与 system-event-log 一致（事件链单一，写盘即落），
   *  避免 caller 在 microtask boundary 之后读到尚未 flush 的状态。 */
  append(record: FileActivityRecord): void {
    if (this.disposed) return;
    // 防墓碑复活：session 已被 rm 掉就别再 mkdir 复活，对齐 system-event-log。
    if (!existsSync(this.sessionRoot)) return;
    if (!this.dirEnsured) {
      mkdirSync(this.sessionRoot, { recursive: true });
      this.dirEnsured = true;
    }
    appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
  }

  /** Read ledger entries from disk; returns the **last `limit`** entries
   *  matching the filter, newest-first. For 5MB+ ledgers we tail the file
   *  rather than parse all of it.
   *
   *  v1 keeps it simple: read whole file (cap at 4MB tail), parse, filter.
   *  Acceptable until we see ledgers cross 5MB —— at which point we'll
   *  add shard rotation (mirrors EventLedger.rotateShard at 5MB). */
  query(opts: {
    path?: string;
    agent?: string;
    limit?: number;
    sinceTs?: number;
  } = {}): FileActivityRecord[] {
    if (!existsSync(this.filePath)) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const out: FileActivityRecord[] = [];
    // newest-first: walk from tail
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec: FileActivityRecord;
      try {
        rec = JSON.parse(lines[i]!) as FileActivityRecord;
      } catch {
        continue;
      }
      if (opts.path && rec.path !== opts.path && rec.fromPath !== opts.path) continue;
      if (opts.agent && rec.agentPath !== opts.agent) continue;
      if (opts.sinceTs != null && rec.ts < opts.sinceTs) continue;
      out.push(rec);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Best-effort file-size check —— for query callers that want to know
   *  whether a UI cache is stale. mtime suffices for the 4s polling pattern
   *  used by AgentsPanel; cheaper than re-parsing. */
  mtimeMs(): number {
    if (!existsSync(this.filePath)) return 0;
    try { return statSync(this.filePath).mtimeMs; } catch { return 0; }
  }

  dispose(): void {
    this.disposed = true;
  }
}
