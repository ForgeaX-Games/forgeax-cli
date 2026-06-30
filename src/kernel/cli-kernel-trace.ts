/**
 * CLI 内核 turn 的 `kernel.turn` span/log —— 全链路 trace 第 2 层。
 *
 * forgeax-core 的 `kernel.turn` 由 sidecar 内部产;CLI 内核(codebuddy / claude-code /
 * codex / cursor)跑在 server 进程、本身**不出 span**。这里在 `runKernelTurn` 里给非-
 * forgeax-core 内核包一层 `kernel.turn`:
 *   - turn 一开始就产 provisional span + "kernel.turn start" log 并**立即落盘** ——
 *     若内核卡住(codebuddy 等网络/MCP/auth 阻塞),trace 里就留下一个**永不收口的 kernel.turn**
 *     (挂在浏览器 `ui.request` 下),配合浏览器侧 `ui.stall` 即可直接定位「卡在内核」。
 *   - turn 结束补 final span + "kernel.turn done" log(status / reason / usage / model)。
 * parent:浏览器 `ui.request` 的 W3C traceparent(无则自建 root,形成独立 trace)。
 *
 * 与 forgeax-core 的 `kernel.turn` 同名同形 → 两类内核在 viewer/落盘里口径一致。
 */
import { randomUUID } from 'node:crypto';
import type { TelemetryRecord } from '@forgeax/types';
import { emitHostTelemetry } from './host-telemetry';

/** 8-byte span id(16 hex):randomUUID 去横线取前 16。 */
function newSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}
/** 16-byte trace id(32 hex):拼两个 randomUUID 取前 32。 */
function newTraceId(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 32);
}

/** 解析 W3C traceparent(`00-<32hex>-<16hex>-<2hex>`)→ {traceId, spanId};非法/全零 → undefined。 */
function parseTraceparent(tp: string | undefined): { traceId: string; spanId: string } | undefined {
  if (!tp) return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(tp.trim());
  if (!m) return undefined;
  if (/^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined;
  return { traceId: m[1], spanId: m[2] };
}

export interface CliKernelTurnTrace {
  /** 收尾:补 final span + done log。 */
  end(o: {
    ok: boolean;
    reason?: string;
    model?: string;
    usage?: { inputTokens: number; outputTokens: number };
    error?: string;
  }): void;
}

/** 起一轮 CLI 内核的 `kernel.turn`(provisional span + start log **立即落盘**)。返回收尾句柄。 */
export function startCliKernelTurn(o: {
  kernelId: string;
  agentId: string;
  sid?: string;
  traceparent?: string;
}): CliKernelTurnTrace {
  const parent = parseTraceparent(o.traceparent);
  const traceId = parent?.traceId ?? newTraceId();
  const spanId = newSpanId();
  const startTs = Date.now();
  const base = {
    traceId,
    spanId,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name: 'kernel.turn',
    ...(o.sid ? { sid: o.sid } : {}),
    agentId: o.agentId,
  };
  emitHostTelemetry(o.sid, [
    { kind: 'span', ...base, startTs, provisional: true, attrs: { kernel: o.kernelId } } as TelemetryRecord,
    {
      kind: 'log',
      ts: startTs,
      level: 'info',
      msg: 'kernel.turn start',
      fields: { kernel: o.kernelId },
      traceId,
      spanId,
      ...(o.sid ? { sid: o.sid } : {}),
      agentId: o.agentId,
    } as TelemetryRecord,
  ]);

  return {
    end(e): void {
      const endTs = Date.now();
      const attrs: Record<string, unknown> = { kernel: o.kernelId };
      if (e.model) attrs.model = e.model;
      if (e.reason) attrs.reason = e.reason;
      if (e.usage) {
        attrs['usage.input'] = e.usage.inputTokens;
        attrs['usage.output'] = e.usage.outputTokens;
      }
      emitHostTelemetry(o.sid, [
        {
          kind: 'span',
          ...base,
          startTs,
          endTs,
          status: e.ok ? { code: 'ok' } : { code: 'error', ...(e.error ? { message: e.error } : {}) },
          attrs,
        } as TelemetryRecord,
        {
          kind: 'log',
          ts: endTs,
          level: e.ok ? 'info' : 'error',
          msg: 'kernel.turn done',
          fields: {
            kernel: o.kernelId,
            status: e.ok ? 'ok' : 'error',
            ...(e.reason ? { reason: e.reason } : {}),
            ...(e.model ? { model: e.model } : {}),
            ...(e.usage ? { usage: e.usage } : {}),
            ...(e.error ? { error: e.error } : {}),
          },
          traceId,
          spanId,
          ...(o.sid ? { sid: o.sid } : {}),
          agentId: o.agentId,
        } as TelemetryRecord,
      ]);
    },
  };
}
