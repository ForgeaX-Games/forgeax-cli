/**
 * cli-kernel-trace + host-telemetry 单元覆盖 —— 全链路 trace 第 2 层(CLI 内核 kernel.turn)。
 * 纯单元:把 host-telemetry 出口换成捕获数组,断言 span/log 形状、parent 挂接、end 收尾、降级。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { setHostTelemetry } from '../src/kernel/host-telemetry';
import { startCliKernelTurn } from '../src/kernel/cli-kernel-trace';

type Rec = Record<string, any>;
let captured: Array<{ sid: string | undefined; records: Rec[] }> = [];
const flat = (): Rec[] => captured.flatMap((c) => c.records);
const spans = (): Rec[] => flat().filter((r) => r.kind === 'span');
const logs = (): Rec[] => flat().filter((r) => r.kind === 'log');

const TP = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

beforeEach(() => {
  captured = [];
  setHostTelemetry((sid, records) => captured.push({ sid, records: records as Rec[] }));
});
afterEach(() => setHostTelemetry(null));

describe('cli-kernel-trace', () => {
  test('start:provisional kernel.turn 挂 traceparent 下 + start log,立即产出', () => {
    startCliKernelTurn({ kernelId: 'codebuddy', agentId: 'forge', sid: 'sid-1', traceparent: TP });
    const prov = spans().find((s) => s.provisional)!;
    expect(prov.name).toBe('kernel.turn');
    expect(prov.traceId).toBe('a'.repeat(32)); // 复用上游 traceId
    expect(prov.parentSpanId).toBe('b'.repeat(16)); // 挂 ui.request 下
    expect(prov.attrs.kernel).toBe('codebuddy');
    expect(prov.sid).toBe('sid-1');
    const startLog = logs().find((l) => l.msg === 'kernel.turn start')!;
    expect(startLog.fields.kernel).toBe('codebuddy');
    expect(startLog.traceId).toBe('a'.repeat(32));
    expect(startLog.spanId).toBe(prov.spanId);
  });

  test('end ok:final span(status ok + usage/model/reason attrs)+ done log', () => {
    const h = startCliKernelTurn({ kernelId: 'codebuddy', agentId: 'forge', sid: 'sid-1', traceparent: TP });
    const provSpanId = spans().find((s) => s.provisional)!.spanId;
    captured = []; // 只看 end 的产出
    h.end({ ok: true, reason: 'stop', model: 'claude-opus-4-8', usage: { inputTokens: 10, outputTokens: 20 } });
    const fin = spans().find((s) => s.endTs != null)!;
    expect(fin.spanId).toBe(provSpanId); // 与 provisional 同 span(收口同一条)
    expect(fin.status).toEqual({ code: 'ok' });
    expect(fin.attrs['usage.input']).toBe(10);
    expect(fin.attrs['usage.output']).toBe(20);
    expect(fin.attrs.model).toBe('claude-opus-4-8');
    expect(fin.attrs.reason).toBe('stop');
    const doneLog = logs().find((l) => l.msg === 'kernel.turn done')!;
    expect(doneLog.level).toBe('info');
    expect(doneLog.fields.status).toBe('ok');
    expect(doneLog.fields.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test('end error:status error + message,done log level=error', () => {
    const h = startCliKernelTurn({ kernelId: 'codebuddy', agentId: 'forge' });
    captured = [];
    h.end({ ok: false, error: 'boom' });
    const fin = spans().find((s) => s.endTs != null)!;
    expect(fin.status).toEqual({ code: 'error', message: 'boom' });
    expect(logs().find((l) => l.msg === 'kernel.turn done')!.level).toBe('error');
  });

  test('无 traceparent → 自建 root(无 parentSpanId,32hex traceId)', () => {
    startCliKernelTurn({ kernelId: 'codex', agentId: 'forge' });
    const prov = spans().find((s) => s.provisional)!;
    expect(prov.parentSpanId).toBeUndefined();
    expect(prov.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('非法 traceparent → 当作无 parent(自建 root,不挂坏 parent)', () => {
    startCliKernelTurn({ kernelId: 'codex', agentId: 'forge', traceparent: 'not-a-traceparent' });
    expect(spans().find((s) => s.provisional)!.parentSpanId).toBeUndefined();
  });

  test('未接 host-telemetry → 静默 no-op(不抛、无产出)', () => {
    setHostTelemetry(null);
    captured = [];
    expect(() => startCliKernelTurn({ kernelId: 'codebuddy', agentId: 'forge' }).end({ ok: true })).not.toThrow();
    expect(flat().length).toBe(0);
  });
});
