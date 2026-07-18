/**
 * 重生事件流(R6 §3)—— 编排层内部可观测,**非内核契约**。
 *
 * 数字生命的「重生/携带/记忆写入」是产品语义,不进 KernelEvent。这里给一个
 * 轻量可订阅 emitter + 环形缓冲(可观测,satisfies R6-05「落 canonical(可观测)」
 * 的最小形态);需要时上层可桥到 observatory / canonical 事件总线。
 */
import type { LifeEvent } from './types';

type Listener = (ev: LifeEvent) => void;

const RING_MAX = 200;
const ring: LifeEvent[] = [];
const listeners = new Set<Listener>();

/** 发一条重生事件:进环形缓冲 + 通知订阅者。监听器异常被吞(可观测性不应反噬主流程)。 */
export function emitLifeEvent(ev: LifeEvent): void {
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  for (const l of listeners) {
    try {
      l(ev);
    } catch {
      /* 监听器异常不影响发射方 */
    }
  }
  if (process.env.FORGEAX_SOUL_DEBUG) {
    try {
      // eslint-disable-next-line no-console
      console.error(`[soul] ${JSON.stringify(ev)}`);
    } catch {
      /* ignore */
    }
  }
}

/** 订阅重生事件;返回取消订阅函数。 */
export function onLifeEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 最近的重生事件(可观测;最多 RING_MAX 条,可按 agentId 过滤)。 */
export function recentLifeEvents(agentId?: string): LifeEvent[] {
  return agentId ? ring.filter((e) => e.agentId === agentId) : ring.slice();
}
