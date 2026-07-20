/**
 * Rewind shadow — 从原始 WAL 事件流算出「哪些事件被回退遮蔽」的**单一真相**(H-01)。
 *
 * 两个投影(LLM 历史 `foldFromStore` / UI transcript `walEventsToUiMessages`)都据此
 * 排除被回退轮次,避免双实现漂移。语义(与 `RewindApplied` payload 一致):
 *   每个未被 revoke 的 `rewind.applied` 事件遮蔽 **[boundary, 该事件位置)** 这段流区间,
 *   boundary = 第 `keepUserTurns` 个(0-based)`user_prompt.submit` 事件的流下标——即
 *   「保留前 keepUserTurns 个用户轮,遮蔽其后、直到本 rewind 事件之前的全部会话」。
 *   本事件之后 append 的新轮次不在区间内 → 天然保留(rewind→续聊→再 rewind 自动叠加)。
 *   `rewind.revoked` 按 rewindId 撤销对应遮蔽(Redo/cancel)。
 *
 * 只遮蔽会话事件即可(非会话事件两投影本就跳过);为简单起见对区间内所有事件置位,
 * 无害。fail-soft:keepUserTurns 大于实际用户轮数 → boundary=事件位置 → 遮蔽空区间。
 *
 * Boundary: 仅 core 相对 import。
 */
import type { CoreEvent } from '../events/types';
import { CoreEventType } from '../events/events';

/** boundary = 第 `keepUserTurns` 个 user_prompt.submit 的流下标(在 [0, before) 内);
 *  不足 keepUserTurns 个 → 返回 before(遮蔽空区间,fail-soft)。 */
function boundaryIndex(events: CoreEvent[], before: number, keepUserTurns: number): number {
  let count = 0;
  for (let i = 0; i < before; i++) {
    if (events[i].type === CoreEventType.UserPromptSubmit) {
      if (count === keepUserTurns) return i;
      count++;
    }
  }
  return before;
}

/**
 * 返回与 `events` 等长的布尔数组:true = 该下标事件被(未撤销的)rewind 遮蔽。
 */
export function computeRewindShadow(events: CoreEvent[]): boolean[] {
  const shadow = new Array<boolean>(events.length).fill(false);

  const revoked = new Set<string>();
  for (const e of events) {
    if (e.type === CoreEventType.RewindRevoked) {
      const id = (e.payload as { rewindId?: string }).rewindId;
      if (typeof id === 'string') revoked.add(id);
    }
  }

  events.forEach((e, p) => {
    if (e.type !== CoreEventType.RewindApplied) return;
    const { rewindId, keepUserTurns } = e.payload as { rewindId?: string; keepUserTurns?: number };
    if (typeof rewindId === 'string' && revoked.has(rewindId)) return;
    const boundary = boundaryIndex(events, p, typeof keepUserTurns === 'number' ? keepUserTurns : 0);
    for (let i = boundary; i < p; i++) shadow[i] = true;
  });

  return shadow;
}
