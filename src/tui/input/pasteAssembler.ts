/**
 * input/pasteAssembler.ts —— bracketed paste 的**有状态**拼装(跨多个 data 事件)。
 *
 * ── 为什么必须有状态(实测 Ink 6.8 / macOS)──
 *   终端发 `ESC[200~<正文>ESC[201~`,但 Ink 把它**拆成多个 keypress 事件**投递,且每个事件
 *   的前导 ESC 会被 Ink 剥掉。实测一次「Cmd+V 空图片粘贴」到达顺序:
 *     事件1 input=`"[200~"`   (起始标记,单独)
 *     事件2 input=`"[201~"`   (结束标记,单独)
 *   文本粘贴则是 `"[200~"` | `"<正文>"`(可能再拆) | `"[201~"`。
 *   ∴ 任何**单事件**判定都不行:只看单事件,起始/结束标记各自落单——要么漏成普通文本(`[201~`
 *   插进输入框),要么空 body 判不出图片。必须**跨事件缓冲**:遇 `[200~` 进粘贴态,累积正文,
 *   遇 `[201~` 收尾一次性产出(有状态的 pasteBuffer + isPasted 标志)。
 *
 * 产出:
 *   - 空 body(收尾时缓冲为空)= Cmd+V 图片唯一信号 → `paste-image-probe`。
 *   - 非空 body → 一枚 `paste`(多字符)或 `char`(单字符);后续折叠/图片路径判定在 Repl.dispatchKey。
 *   - 结束标记后夹带的回车(粘贴+回车)→ 追加 `enter`,提交不丢。
 *   - 非粘贴输入 → 原样交给 normalizeKey(纯函数,保持不变)。
 *
 * Boundary(HOST 层):仅 core 类型 + 相对 import(type-only 引 ink Key)。
 */
import type { Key as InkKey } from 'ink';
import type { Key } from '../contracts';
import { normalizeKey } from './normalize';

/** 起始/结束标记(容忍前导 ESC 有无:Ink 常已剥,但保险都认)。 */
const START = /\x1b?\[200~/;
const END = /\x1b?\[201~/;

/** 收尾一次粘贴:按 body 内容产出 Key(空=图片探针;单字符=char;否则=paste)。 */
function finalizePaste(body: string): Key[] {
  if (body === '') return [{ kind: 'paste-image-probe' }];
  if (Array.from(body).length === 1 && !body.includes('\n')) return [{ kind: 'char', text: body }];
  return [{ kind: 'paste', text: body }];
}

export interface PasteAssembler {
  /** 喂一次 Ink 投递,返回本次应派发的归一化 Key[](粘贴态内累积则返回空)。 */
  feed(input: string, raw: InkKey): Key[];
  /** 是否处于粘贴累积态(测试/诊断用)。 */
  readonly active: boolean;
}

/**
 * 造一个有状态的粘贴拼装器。整 TUI 唯一 useInput 里持有一枚(useRef),每次投递经它。
 */
export function createPasteAssembler(): PasteAssembler {
  let inPaste = false;
  let buf = '';

  function feed(input: string, raw: InkKey): Key[] {
    if (!inPaste) {
      const sm = START.exec(input);
      if (!sm) return normalizeKey(input, raw); // 普通输入:交给纯归一化
      // 起始标记出现:其前的内容(极少见)当普通输入;标记后进入粘贴态。
      const before = input.slice(0, sm.index);
      const rest = input.slice(sm.index + sm[0].length);
      const out: Key[] = before ? normalizeKey(before, raw) : [];
      const em = END.exec(rest);
      if (em) {
        // 起始+结束同一事件:直接收尾。
        out.push(...finalizePaste(rest.slice(0, em.index)));
        const trailing = rest.slice(em.index + em[0].length);
        if (/[\r\n]/.test(trailing)) out.push({ kind: 'enter' });
        return out;
      }
      inPaste = true;
      buf = rest;
      return out; // 起始已吞,正文待续
    }

    // 粘贴态:找结束标记。
    const em = END.exec(input);
    if (!em) {
      buf += input; // 累积正文(含换行);不产键
      return [];
    }
    buf += input.slice(0, em.index);
    const trailing = input.slice(em.index + em[0].length);
    const out = finalizePaste(buf);
    inPaste = false;
    buf = '';
    if (/[\r\n]/.test(trailing)) out.push({ kind: 'enter' });
    return out;
  }

  return {
    feed,
    get active() {
      return inPaste;
    },
  };
}
