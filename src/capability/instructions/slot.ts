/**
 * Instructions slot —— 把装载好的分层指令文本注入为一个 static system-prompt 段。
 *
 * 与 memory slot 同姿态:static(dynamic:false,随 /clear|/compact 失效,不每轮重算),
 * 文本在 pack 构造期一次性快照(进稳定缓存前缀,字节稳定 → 命中 prompt cache)。
 * 空文本 → render 返 null(本轮不注入)。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { Slot } from '../types';

/** 造 instructions slot:render 恒返构造期快照的指令文本(空 → null)。 */
export function makeInstructionsSlot(text: string): Slot {
  const snapshot = text.trim();
  return {
    name: 'instructions',
    dynamic: false,
    render: () => (snapshot ? snapshot : null),
  };
}
