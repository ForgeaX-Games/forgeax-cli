/**
 * host-telemetry —— 编排层(跑在 server 进程内)产出的 telemetry 出口单例。
 *
 * forgeax-core 的 span 由 sidecar 内部产出、经 RPC 回流到 server adapter 落盘 + 广播;
 * 但 CLI 内核(codebuddy / claude-code / codex / cursor)直接跑在 server 进程里,**没有**
 * 这条回流通道。本单例由产品壳(server `main.ts`)注入「写盘 + WS 广播」回调,使 CLI 内核
 * 的 `kernel.turn` span/log 能落到同一份项目本地 `.forgeax/sessions/<sid>/logs/`、与浏览器
 * span 拼成同一棵 trace。未注入(纯 cli / 无 server)→ 静默 no-op(§9 优雅降级)。
 *
 * 与 forgeax-core 的对称:adapter 经 `opts.telemetrySink + broadcast` 出墙;CLI 内核经此单例。
 */
import type { TelemetryRecord } from '@forgeax/types';

type HostTelemetryEmit = (sid: string | undefined, records: TelemetryRecord[]) => void;

let emit: HostTelemetryEmit | null = null;

/** 产品壳注入出口(= sink.write + broadcast);传 null 解绑。 */
export function setHostTelemetry(fn: HostTelemetryEmit | null): void {
  emit = fn;
}

/** 是否已接出口 —— CLI 内核据此决定是否产 telemetry(没接就别白算)。 */
export function hostTelemetryEnabled(): boolean {
  return emit !== null;
}

/** 产出一批 telemetry record(best-effort,绝不反噬主流程)。 */
export function emitHostTelemetry(sid: string | undefined, records: TelemetryRecord[]): void {
  if (!emit || records.length === 0) return;
  try {
    emit(sid, records);
  } catch {
    /* 可观测性永不反噬主流程 */
  }
}
