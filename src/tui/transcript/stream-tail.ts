/**
 * stream-tail —— 在写流式文本的「尾部视口裁剪」(纯函数,可单测)。
 *
 * 病根:Transcript 把在写 streamingText 整段渲染在 Ink live 动态区,动态区一旦高过
 * 终端视口,Ink 每帧 eraseLines 只能擦到视口内的行,溢出顶部的行进 scrollback 擦不掉
 * → 每个节流帧都留一份残影(同段文本重复刷屏,resize 清屏才消)。LiveThinking 已用
 * MAX_LINES 尾裁防住 thinking 通道;本模块给 text 通道补上同样的保护,且按**视觉行**
 * (displayWidth 折行,CJK 感知)估算——纯 raw 行数会低估长段落的换行行数,防不住。
 *
 * 裁剪只影响在飞呈现:assistant 事件收口后 durable 条目仍是全文(进 <Static>)。
 * 被裁掉的开头本来也早滚出视口;代价仅是截断处 markdown 结构(如代码围栏)可能
 * 短暂降级为纯文本,收口即恢复。
 *
 * 行数是**粗估**(markdown 装饰按 0 近似),预算已留余量,不追求逐行精确
 * (同 redraw-window 的取舍)。
 *
 * Boundary(HOST 层):仅相对 import,无 react/ink,纯函数。
 */
import { displayWidth } from '../text-width';

/** 视口内给动态区其它内容预留的行数:输入框(4)+ 状态栏(2)+ 条目间距/在飞工具卡余量。 */
export const STREAM_TAIL_RESERVED_ROWS = 12;
/** 流式文本至少可见的行数(极矮终端下的下限)。 */
export const STREAM_TAIL_MIN_ROWS = 4;

/** 流式文本的可用视觉行预算:终端高 − 预留,不低于下限。 */
export function streamTailBudget(rows: number): number {
  return Math.max(STREAM_TAIL_MIN_ROWS, rows - STREAM_TAIL_RESERVED_ROWS);
}

/** 单条 raw 行按宽 cols 硬换行后的视觉行数(空行也占 1 行)。 */
function wrappedRows(line: string, cols: number): number {
  return Math.max(1, Math.ceil(displayWidth(line) / Math.max(1, cols)));
}

/** 从行尾按显示宽度保留至多 maxRows*cols 列的字符(单条超预算行的字符级切尾)。 */
function sliceTailByWidth(line: string, cols: number, maxRows: number): string {
  const budget = Math.max(1, cols) * maxRows;
  const chars = [...line];
  let w = 0;
  let i = chars.length;
  while (i > 0) {
    const cw = displayWidth(chars[i - 1]!);
    if (w + cw > budget) break;
    w += cw;
    i--;
  }
  return i === 0 ? line : chars.slice(i).join('');
}

/**
 * 从末尾向前保留至多 maxRows 视觉行的 raw 行,前部整行丢弃(clipped=true 时调用方
 * 自行渲染 `…` 截断标记)。仅剩的末行若独自超预算(无换行的长段落),降到字符级切尾
 * ——按行裁切不动它,不切则动态区仍超视口、残影照旧。
 */
export function clipStreamTail(
  text: string,
  cols: number,
  maxRows: number,
): { text: string; clipped: boolean } {
  if (!text) return { text, clipped: false };
  const lines = text.split('\n');
  let rows = 0;
  let start = lines.length - 1; // 兜底:至少保留最后一条 raw 行
  for (let i = lines.length - 1; i >= 0; i--) {
    rows += wrappedRows(lines[i]!, cols);
    if (rows > maxRows) {
      start = Math.min(i + 1, lines.length - 1);
      break;
    }
    start = i;
  }
  // 兜底命中且末行独自超预算 → 字符级切尾(被裁部分本来也早滚出视口)。
  if (start === lines.length - 1 && wrappedRows(lines[start]!, cols) > maxRows) {
    return { text: sliceTailByWidth(lines[start]!, cols, maxRows), clipped: true };
  }
  if (start === 0) return { text, clipped: false };
  return { text: lines.slice(start).join('\n'), clipped: true };
}
