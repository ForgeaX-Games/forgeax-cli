/** AgentFs recorder —— 把 `AgentFsAPI` 的 mutation 方法包一层，每次成功
 *  写盘后向 session 的 file-activity ledger append 一条记录，并向 EventBus
 *  发一条 `file-activity` 事件让 WS 把变更推给 UI。
 *
 *  覆盖面（chokepoint 分析见 design summary）：
 *    write_file       → ctx.fs.writeText        ✓ wrapped
 *    edit_file        → ctx.fs.writeText        ✓ wrapped (op="edit" via heuristic)
 *    multi_edit       → ctx.fs.writeText        ✓ wrapped (同上)
 *    apply_patch      → ctx.fs.writeText/writeBinarySync/renameSync/unlinkSync ✓
 *
 *  额外：appendTextSync / writeTextSync / writeBinarySync / unlinkSync /
 *  renameSync / rmSync —— 一并 wrap，凡是 agent 经 ctx.fs 改盘都进 ledger。
 *  read 路径**不**包，避免 ledger 涨爆。
 *
 *  Lock 行为：
 *    - 写之前 acquire `Map<absPath, {agentPath, since, op}>`
 *    - 写完（成功 or 异常）release
 *    - 同一时刻其他 agent 不被强行阻断（v1 仅做"标识"，UI 渲染 🔒；强阻断
 *      要等 agent 间真出现 race 后再加。Filesystem 本身已有 fs lock；ledger
 *      lock 主要是给 UI 看「现在谁正在写这文件」）
 *
 *  Op 推断：方法名 → op。`writeText` 的 caller 可能是 write_file（覆盖）
 *  也可能是 edit_file / multi_edit（增量），底层调用一致 → 我们这边只看
 *  方法名记 "write"。需要更细粒度（"edit" / "patch"）的 caller 用显式
 *  `record()` API（暴露给 apply_patch 之类）。 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentFsAPI } from "./agent-fs";
import type { FileActivityLedger, FileActivityOp, FileActivityRecord } from "../ledger/file-activity-ledger";

/** Per-session lock map —— { absPath → who's editing }. */
export interface FileLockSnapshot {
  agentPath: string;
  op: FileActivityOp;
  /** Unix ms */
  since: number;
}
export type FileLockMap = Map<string, FileLockSnapshot>;

/** Hooks fed by Session into the recorder factory. Splits the recorder from
 *  Session imports to avoid an import cycle (agent-fs → fs/types → core/...). */
export interface RecorderHooks {
  ledger: FileActivityLedger;
  locks: FileLockMap;
  /** Emit a `file-activity` event on the session bus. emitterId = agentPath
   *  so existing per-agent ledger persistence routes the event into that
   *  agent's own EventLedger as well —— LLM context inherits the activity
   *  signal "for free" without a separate slot read. */
  emit: (record: FileActivityRecord, kind: "start" | "done") => void;
}

const HASH_THRESHOLD_BYTES = 1 * 1024 * 1024; // skip hash for >1MB writes

function quickHash(content: string | Uint8Array): string | undefined {
  try {
    const len = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    if (len > HASH_THRESHOLD_BYTES) return undefined;
    const h = createHash("sha256");
    h.update(typeof content === "string" ? content : Buffer.from(content));
    return h.digest("hex");
  } catch {
    return undefined;
  }
}

function byteLen(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
}

/** Build a wrapped AgentFsAPI that records mutations. Returns the same
 *  surface as the input (so callers passing `agentContext.fs` see no
 *  difference) plus a tiny escape-hatch:
 *
 *    - The wrapped object exposes `__recordExplicit(record)` for tools
 *      that bypass writeText (eg apply_patch's own `writeBinary`). Cast
 *      to `FsWithRecorder` to use it.
 *
 *  Wrap is per-agent, constructed in BaseAgent ctor so each agent's
 *  recorder carries its own `agentPath` —— no caller needs to pass agent
 *  identity at write time. */
export interface FsWithRecorder extends AgentFsAPI {
  __recordExplicit(record: Omit<FileActivityRecord, "ts">): void;
  /** Same lock+emit cycle as writeText, but caller picks the op kind. Lets
   *  apply_patch / edit_file mark records as op:"patch" / "edit" instead of
   *  the default "write". One record per file is still the rule —— "patch"
   *  describes the kind of mutation, not how many files participated. */
  recordedWrite(path: string, content: string, op: FileActivityOp): Promise<void>;
}

export function wrapAgentFsWithRecorder(
  inner: AgentFsAPI,
  agentPath: string,
  hooks: RecorderHooks,
): FsWithRecorder {
  const writeRecord = (rec: FileActivityRecord): void => {
    try {
      hooks.ledger.append(rec);
      hooks.emit(rec, "done");
    } catch {
      /* ledger errors must never break the write. swallowed. */
    }
  };

  /** Acquire-around-call helper. Holds lock on `path` (and `fromPath` for
   *  rename) for the duration of fn(); always releases in finally. */
  const around = <T>(
    path: string,
    op: FileActivityOp,
    fn: () => T,
    onSuccess: () => Omit<FileActivityRecord, "ts">,
    fromPath?: string,
  ): T => {
    const since = Date.now();
    hooks.locks.set(path, { agentPath, op, since });
    if (fromPath) hooks.locks.set(fromPath, { agentPath, op, since });
    // 派 start 事件，让 UI 立刻看到锁。done 事件在写盘成功后由 writeRecord 派。
    hooks.emit(
      { ts: since, agentPath, op, path, ...(fromPath ? { fromPath } : {}) },
      "start",
    );
    try {
      const result = fn();
      const partial = onSuccess();
      writeRecord({ ts: Date.now(), ...partial });
      return result;
    } finally {
      hooks.locks.delete(path);
      if (fromPath) hooks.locks.delete(fromPath);
    }
  };

  /** async variant —— 同步 lock acquire / release，但 fn 是 await 的。 */
  const aroundAsync = async <T>(
    path: string,
    op: FileActivityOp,
    fn: () => Promise<T>,
    onSuccess: () => Omit<FileActivityRecord, "ts">,
  ): Promise<T> => {
    const since = Date.now();
    hooks.locks.set(path, { agentPath, op, since });
    hooks.emit({ ts: since, agentPath, op, path }, "start");
    try {
      const result = await fn();
      const partial = onSuccess();
      writeRecord({ ts: Date.now(), ...partial });
      return result;
    } finally {
      hooks.locks.delete(path);
    }
  };

  const wrapped: FsWithRecorder = {
    // ─── pass-through (read / no-mutation) ───────────────────────────────
    resolve: inner.resolve,
    needsProxy: inner.needsProxy,
    readText: inner.readText.bind(inner),
    readBinary: inner.readBinary.bind(inner),
    exists: inner.exists.bind(inner),
    stat: inner.stat.bind(inner),
    listDir: inner.listDir.bind(inner),
    mkdir: inner.mkdir.bind(inner),
    glob: inner.glob.bind(inner),
    grep: inner.grep.bind(inner),
    readTextSync: inner.readTextSync,
    existsSync: inner.existsSync,
    statSync: inner.statSync,
    mkdirSync: inner.mkdirSync,
    readdirSync: inner.readdirSync,

    // ─── wrapped (mutation) ──────────────────────────────────────────────

    writeText(path, content) {
      const abs = inner.resolve(path);
      const isCreate = !existsSync(abs);
      return aroundAsync(abs, "write", () => inner.writeText(path, content), () => ({
        agentPath, op: "write", path: abs,
        bytes: byteLen(content), isCreate,
        ...(quickHash(content) ? { hash: quickHash(content)! } : {}),
      }));
    },

    writeTextSync(path, content) {
      const abs = inner.resolve(path);
      const isCreate = !existsSync(abs);
      around(abs, "write", () => inner.writeTextSync(path, content), () => ({
        agentPath, op: "write", path: abs,
        bytes: byteLen(content), isCreate,
        ...(quickHash(content) ? { hash: quickHash(content)! } : {}),
      }));
    },

    writeBinarySync(path, data) {
      const abs = inner.resolve(path);
      const isCreate = !existsSync(abs);
      around(abs, "write", () => inner.writeBinarySync(path, data), () => ({
        agentPath, op: "write", path: abs,
        bytes: byteLen(data), isCreate,
      }));
    },

    appendTextSync(path, content) {
      const abs = inner.resolve(path);
      const isCreate = !existsSync(abs);
      around(abs, "append", () => inner.appendTextSync(path, content), () => ({
        agentPath, op: "append", path: abs,
        bytes: byteLen(content), isCreate,
      }));
    },

    unlinkSync(path) {
      const abs = inner.resolve(path);
      around(abs, "delete", () => inner.unlinkSync(path), () => ({
        agentPath, op: "delete", path: abs,
      }));
    },

    renameSync(oldPath, newPath) {
      const absOld = inner.resolve(oldPath);
      const absNew = inner.resolve(newPath);
      around(absNew, "rename", () => inner.renameSync(oldPath, newPath), () => ({
        agentPath, op: "rename", path: absNew, fromPath: absOld,
      }), absOld);
    },

    rmSync(path, opts?) {
      const abs = inner.resolve(path);
      around(abs, "delete", () => inner.rmSync(path, opts), () => ({
        agentPath, op: "delete", path: abs,
      }));
    },

    // ─── escape hatch for tools that want a non-default op ──────────────
    __recordExplicit(record) {
      writeRecord({ ts: Date.now(), ...record });
    },

    recordedWrite(path, content, op) {
      const abs = inner.resolve(path);
      const isCreate = !existsSync(abs);
      return aroundAsync(abs, op, () => inner.writeText(path, content), () => ({
        agentPath, op, path: abs,
        bytes: byteLen(content), isCreate,
        ...(quickHash(content) ? { hash: quickHash(content)! } : {}),
      }));
    },
  };

  return wrapped;
}
