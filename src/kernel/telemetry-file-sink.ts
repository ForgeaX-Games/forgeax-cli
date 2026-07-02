/**
 * Host-side telemetry file sink (Track S · observability v3 / B 档).
 *
 * forgeax-core serve 子进程经 RPC `conn.notify('telemetry', { records })` 把 span/log
 * 记录推回宿主(out-of-band,与 `event` 平行);adapter 的 telemetry 分支调本 sink
 * **append-JSONL 落盘**到该 session 的 logs 目录:
 *   - kind==='span' → `<userRoot>/sessions/<sid>/logs/trace.jsonl`
 *   - kind==='log'  → `<userRoot>/sessions/<sid>/logs/log.jsonl`
 *
 * 路径约定 **复用** forgeax-cli 的 PathManager(`getPathManager().session(sid).logsDir()`,
 * = `<userRoot>/sessions/<sid>/logs/`),与既有 per-session `debug.log` / `latest.log` /
 * `global-events.jsonl` 同目录、同 sid 命名空间——不另起一套路径语义(SSOT)。
 *
 * 大小轮转:append 字节累计达 MAX_FILE_SIZE(50MB)→ 把 `f` → `f.1` → … → `f.N`
 * 平移(最多 MAX_ROTATIONS 个历史档),与 cli/logger.ts 的 rotateLogFile 同策略,但**自带**
 * 一份极简实现(不 import packages/cli 的 logger,避免把 console-bridge 整套状态机拖进来)。
 *
 * 可观测性铁律:落盘绝不能反噬主流程——所有写盘 best-effort,内部 try/catch 吞掉并
 * 经注入的 `onError` 上报(adapter 把它接到 turn-trace),**永不**向 RPC 层抛。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { getPathManager } from '../fs/path-manager';
// 仅 type-only:契约形状来自 SSOT wire schema(编译期擦除,不引入运行期依赖)。
import type { TelemetryRecord } from '@forgeax/types';

/** 单档上限 50MB,与 cli/logger.ts 的 MAX_FILE_SIZE 对齐。 */
const MAX_FILE_SIZE = 50 * 1024 * 1024;
/** 历史档数量上限(`f.1` … `f.5`),与 cli/logger.ts 的 MAX_ROTATIONS 对齐。 */
const MAX_ROTATIONS = 5;

/** 内存里记每个目标文件的当前字节数,省去每次 append 都 statSync。 */
const byteCounters = new Map<string, number>();

function currentBytes(file: string): number {
  const cached = byteCounters.get(file);
  if (cached !== undefined) return cached;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  byteCounters.set(file, size);
  return size;
}

/** `f.4`→`f.5`、…、`f.1`→`f.2`、`f`→`f.1` 平移(与 logger.rotateLogFile 同序)。 */
function rotate(file: string): void {
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  if (existsSync(file)) renameSync(file, `${file}.1`);
  byteCounters.set(file, 0);
}

/** 往一个 JSONL 文件 append 一批行(各自一行 JSON),按 MAX_FILE_SIZE 滚动。 */
function appendLines(file: string, lines: string[]): void {
  if (lines.length === 0) return;
  mkdirSync(join(file, '..'), { recursive: true });
  const payload = lines.join('');
  let bytes = currentBytes(file);
  // 写前若已到上限先滚一次,然后追加;追加后若又到上限,下一批进来再滚。
  if (bytes >= MAX_FILE_SIZE) {
    rotate(file);
    bytes = 0;
  }
  appendFileSync(file, payload);
  byteCounters.set(file, bytes + Buffer.byteLength(payload));
}

/** host-side telemetry file sink:把一批 records 按 kind 分流落该 session 的 logs 目录。 */
export interface TelemetryFileSink {
  /** 把 records 落盘(span→trace.jsonl / log→log.jsonl);best-effort,绝不抛。 */
  write(sid: string | undefined, records: TelemetryRecord[]): void;
  /**
   * session 驱逐时回收该 sid 的字节计数缓存(trace.jsonl + log.jsonl 两键),
   * 避免 byteCounters 随长生命周期 server 的 session 数单调增长。best-effort,绝不抛。
   */
  evict(sid: string | undefined): void;
}

export interface TelemetryFileSinkOpts {
  /** 落盘出错时上报(best-effort 诊断;adapter 接到 turn-trace)。 */
  onError?: (err: unknown) => void;
  /** 测试注入:覆盖 logs 目录解析(默认走 forgeax-cli PathManager)。 */
  resolveLogsDir?: (sid: string) => string;
}

/** 构造一个 host-side telemetry file sink。 */
export function createTelemetryFileSink(opts: TelemetryFileSinkOpts = {}): TelemetryFileSink {
  const resolveLogsDir =
    opts.resolveLogsDir ?? ((sid: string) => getPathManager().session(sid).logsDir());

  return {
    write(sid, records): void {
      if (!sid || !Array.isArray(records) || records.length === 0) return;
      try {
        const logsDir = resolveLogsDir(sid);
        const spanLines: string[] = [];
        const logLines: string[] = [];
        for (const rec of records) {
          if (!rec || typeof rec !== 'object') continue;
          const kind = (rec as { kind?: unknown }).kind;
          let line: string;
          try {
            line = JSON.stringify(rec) + '\n';
          } catch {
            continue; // 不可序列化(循环引用等)→ 丢弃单条,不拖垮整批
          }
          if (kind === 'span') spanLines.push(line);
          else if (kind === 'log') logLines.push(line);
          // 未知 kind:既不落 trace 也不落 log(schema 之外的形状,静默丢)
        }
        appendLines(join(logsDir, 'trace.jsonl'), spanLines);
        appendLines(join(logsDir, 'log.jsonl'), logLines);
      } catch (err) {
        opts.onError?.(err);
      }
    },
    evict(sid): void {
      if (!sid) return;
      try {
        const logsDir = resolveLogsDir(sid);
        byteCounters.delete(join(logsDir, 'trace.jsonl'));
        byteCounters.delete(join(logsDir, 'log.jsonl'));
      } catch {
        // 路径解析失败就不清(下次 write 会按 statSync 重建)——绝不抛。
      }
    },
  };
}

/** 测试辅助:清空字节计数缓存(隔离用例间的滚动状态)。 */
export function __resetTelemetryFileSinkState(): void {
  byteCounters.clear();
}
