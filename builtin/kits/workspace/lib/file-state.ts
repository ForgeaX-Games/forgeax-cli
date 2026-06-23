/** 跟踪 read_file 之后的内容 hash —— write_file / edit_file 时检测外部修改。
 *
 *  当前实现：纯宿主机内存表（Map<absPath, sha256>），跨进程不共享。
 *  sandbox 接入后，容器路径会被 needsProxy() 标记为 true，本模块统一跳过——
 *  那部分的 staleness 检测依赖 container fs 的 readTextSync，目前没有。 */

import { createHash } from "node:crypto";
import { getHostFs } from "../../../../src/fs/agent-fs";
import type { AgentFsAPI } from "../../../../src/fs/agent-fs";

const fileHashes = new Map<string, string>();

function hash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Record file content hash after read. needsProxy 的路径直接跳过。 */
export async function recordFileRead(
  absPath: string,
  _mtimeMs: number,
  content: string,
  isPartial: boolean,
  fs?: AgentFsAPI,
): Promise<void> {
  if (fs?.needsProxy(absPath)) return;
  if (isPartial) {
    try { fileHashes.set(absPath, hash(getHostFs().readTextSync(absPath))); } catch { /* ignore */ }
  } else {
    fileHashes.set(absPath, hash(content));
  }
}

/** Update file content hash after write. */
export function clearFileRead(
  absPath: string,
  _mtimeMs?: number,
  content?: string,
  fs?: AgentFsAPI,
): void {
  if (fs?.needsProxy(absPath)) return;
  if (content !== undefined) fileHashes.set(absPath, hash(content));
  else fileHashes.delete(absPath);
}

/** Content-hash 比对，免疫 mtime-only 改动。 */
export async function checkStaleness(absPath: string, fs?: AgentFsAPI): Promise<string | undefined> {
  if (fs?.needsProxy(absPath)) return undefined;
  const h = fileHashes.get(absPath);
  if (!h) return undefined;
  try {
    if (hash(getHostFs().readTextSync(absPath)) === h) return undefined;
  } catch { /* treat as stale */ }
  return "File has been externally modified since last read (content changed). Re-read the file before editing to avoid overwriting changes.";
}
