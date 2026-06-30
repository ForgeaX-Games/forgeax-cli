// @desc Command module: history — fetch_session_events / fetch_blob
//
// 镜像 agenteam-os-ref:
//   - `commands/sessions.ts::fetch_session_events`（reads events-N.jsonl tail
//     since 上一个 compact_boundary，sentinel pass-through）
//   - `commands/blob.ts::fetch_blob`（按 sha256 取原始 bytes，path-safety 严守）
//
// ref ↔ forgeax 语义映射（plan §3.4 已钉死）：
//   ref 一个 agent 多 session → forgeax 一个 sid 多 agent，**ledger 与 (sid,
//   agentPath) 一一对应**。所以 ref `args[0]=agentId` 在我们这里裂成
//   `args[0]=sid, args[1]=agentPath`，没有 ref 的 switch-session / active
//   session 指针，因为 forgeax 切 session 直接换 sid。
//
// 参数：
//   fetch_session_events   args[0]=sid, args[1]=agentPath                          hasQuery
//   fetch_blob             args[0]=sid, args[1]=agentPath, args[2]=sha256(16hex)   hasQuery
//
// compact_boundary：当前 ConsciousAgent 还没真接 compaction tool，但 user 已经
// 说"未来会加回来的，目前可以假设他已经有了" —— 反扫一旦遇 type==="compact_boundary"
// 就停。盘上没这种 event 时，反扫读完所有 shard 返回全量。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { CommandModule } from "../../src/commands/types";
import type { StoredEvent } from "../../src/ledger/types";
import { parseEvents } from "../../src/ledger/event-store";

const SHARD_RE = /^events-(\d+)\.jsonl$/;

function isSafePathSegment(s: string): boolean {
  if (!s || s.length > 128) return false;
  if (s === "." || s === "..") return false;
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) return false;
  if (!/^[a-zA-Z0-9_\-.]+$/.test(s)) return false;
  if (s.startsWith(".")) return false;
  return true;
}

/** forgeax agentPath 可能多段（`iori/agents/suzu`）—— 跟 ref blob.ts 的 isSafePathSegment
 *  不同，这里允许内部 `/` 但禁绝对路径、禁 `..` 段、禁 \0、禁空段。
 *  对应 PathManager 内部 normalizeAgentPath 的同款宽松度，但不复用因为这层是
 *  外部攻击面 —— 严格只接受 `[A-Za-z0-9_-.]+(/[A-Za-z0-9_-.]+)*`。 */
function isSafeAgentPath(s: string): boolean {
  if (!s || s.length > 512) return false;
  if (s.startsWith("/") || s.includes("\\") || s.includes("\0")) return false;
  for (const seg of s.split("/")) {
    if (!isSafePathSegment(seg)) return false;
  }
  return true;
}

function listShardPaths(eventsDir: string): string[] {
  if (!existsSync(eventsDir)) return [];
  let entries: string[];
  try { entries = readdirSync(eventsDir); } catch { return []; }
  const shards: Array<[number, string]> = [];
  for (const f of entries) {
    const m = SHARD_RE.exec(f);
    if (m) shards.push([parseInt(m[1], 10), join(eventsDir, f)]);
  }
  shards.sort((a, b) => a[0] - b[0]);
  return shards.map(([, p]) => p);
}

function hasCompactBoundary(events: StoredEvent[]): boolean {
  // 与 ref `commands/sessions.ts:9-12` 同款 —— 反向扫找首个 compact_boundary。
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "compact_boundary") return true;
  }
  return false;
}

function serializeJsonl(events: StoredEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

/** 倒序读 shard 列表，每读完一个 shard 调一次 `isEnough(累积)` 判断是否停。
 *  与 EventLedger.readFromTail 同语义，但**不**经过 parseEvents 的 blobsDir
 *  reinflate 路径（外部展示侧的 sentinel pass-through）。 */
function readEventsFromTailRaw(
  eventsDir: string,
  isEnough: (events: StoredEvent[]) => boolean,
): StoredEvent[] {
  const paths = listShardPaths(eventsDir);
  const result: StoredEvent[] = [];
  for (let i = paths.length - 1; i >= 0; i--) {
    let raw: string;
    try { raw = readFileSync(paths[i], "utf-8"); } catch { continue; }
    // parseEvents 不传 blobsDir → sentinel pass-through。malformed line 由
    // parseEvents 内部静默 skip。
    const batch = parseEvents(raw);
    result.unshift(...batch);
    if (isEnough(result)) break;
  }
  return result;
}

const history: CommandModule = {
  async list() {
    return [
      {
        name: "fetch_session_events",
        description: "事件流 raw JSONL（args[0]=sid, args[1]=agentPath；tail 到上一个 compact_boundary；sentinel pass-through）",
        hasQuery: true,
        hasExecute: false,
      },
      {
        name: "fetch_blob",
        description: "按 sha256 取 sentinel 对应的原始 bytes（args[0]=sid, args[1]=agentPath, args[2]=sha256[16hex]；返回 { sha256, bytes, data:base64 }）",
        hasQuery: true,
        hasExecute: false,
      },
    ];
  },

  async query(name, args, ctx) {
    if (name === "fetch_session_events") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
      if (!isSafePathSegment(sid)) {
        throw new Error(`${name}: sid is not a safe single path segment`);
      }
      if (!isSafeAgentPath(agentPath)) {
        throw new Error(`${name}: agentPath is not a safe relative path`);
      }
      // 不走 sm.open —— fetch_session_events 只读盘，不需要 attach session
      // 实例（agentTree / scheduler 等都不需要）；跟 ref `sessions.ts` 同样
      // 是「外部展示 surface」走 fs 直读，不动 runtime state。
      const eventsDir = ctx.paths.session(sid).agent(agentPath).eventsDir();
      return serializeJsonl(readEventsFromTailRaw(eventsDir, hasCompactBoundary));
    }

    if (name === "fetch_blob") {
      const sid = (args[0] ?? "").trim();
      const agentPath = (args[1] ?? "").trim();
      const sha256 = (args[2] ?? "").trim();
      if (!sid) throw new Error(`${name}: args[0] (sid) required`);
      if (!agentPath) throw new Error(`${name}: args[1] (agentPath) required`);
      if (!isSafePathSegment(sid)) {
        throw new Error(`${name}: sid is not a safe single path segment`);
      }
      if (!isSafeAgentPath(agentPath)) {
        throw new Error(`${name}: agentPath is not a safe relative path`);
      }
      // 严格 16hex（ref blob.ts 同款；event-blob.ts 内部 hash 也是 slice(0,16)）。
      if (!/^[a-f0-9]{16}$/.test(sha256)) {
        throw new Error(`${name}: sha256 must be 16-hex (got '${sha256}')`);
      }

      const blobsDir = resolve(ctx.paths.session(sid).agent(agentPath).eventLedgerBlobs());
      const blobPath = resolve(join(blobsDir, `${sha256}.bin`));
      // belt-and-braces containment check —— 即便 sha256 已严格 16hex 限制，
      // resolve 之后仍校验路径必须落在 blobsDir 内（防 symlink / normalize 怪招）。
      if (blobPath !== join(blobsDir, `${sha256}.bin`) && !blobPath.startsWith(blobsDir + sep)) {
        throw new Error(`${name}: resolved path escapes blob directory`);
      }
      if (!existsSync(blobPath)) {
        // 不回显绝对路径 —— 跟 ref 一致，错误信息保持稳定，不泄漏 fs layout。
        throw new Error(`${name}: blob not found (sid=${sid}, agentPath=${agentPath}, sha256=${sha256})`);
      }

      const bytes = readFileSync(blobPath);
      return {
        sha256,
        sid,
        agentPath,
        bytes: bytes.length,
        data: bytes.toString("base64"),
      };
    }

    throw new Error(`No query for: ${name}`);
  },
};

export default history;
