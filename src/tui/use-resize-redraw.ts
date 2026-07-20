/**
 * transcript 整体替换时的终端清场。
 *
 * resize 不走这里：终端本身会 reflow scrollback，Ink patch 只按新列宽重算动态区的擦除
 * 高度并原地重画。这样 resize 不清屏、不重放 Static，也就没有历史重复、断层或 banner
 * 再次出现的问题。本函数只服务 /clear、/resume、rewind 这类内容身份真正改变的操作。
 */
import { inkInstanceRef } from './ink-instance-ref';
import { COMMAND_CLOSE, shellMarksEnabled } from './shell-marks';

/** eraseScreen = ERASE_SCREEN + CURSOR_HOME。刻意不发 3J:resize 不应销毁用户的 scrollback。 */
const ESC = String.fromCharCode(27); // 避免源码内裸 ESC 字节被 formatter 弄坏
const ERASE_SCREEN = `${ESC}[2J${ESC}[H`;

/**
 * 干净重绘的「清场」两步:① 清 ink 的 Static 累加器 + 动态区记账;② 清当前视口。
 * resize 默认保留 scrollback；resume / rewind / clear 这类整体替换可显式清掉旧 scrollback，
 * 避免已经不属于当前 transcript 的内容仍能向上滚到。
 *
 * 注意:这两步只「清旧」;真正让 `<Static>` **重新 emit 全部条目**还需调用方给它换 key
 * 重挂载(见 useResizeRedraw 的 staticKey / Transcript 的 redrawNonce)。
 */
export function cleanRedraw(options: { clearScrollback?: boolean } = {}): void {
  inkInstanceRef.current?.resetStaticOutput?.();
  try {
    // 清屏前先收口当前 open command(D;0):VS Code 拦截 2J 时会把视口内已提交的 command
    //   连记账一起清,不先收口会残留一条持陈旧 marker 的垃圾条目。仅真 TTY 发(见 shell-marks)。
    if (shellMarksEnabled()) process.stdout.write(COMMAND_CLOSE);
    process.stdout.write(options.clearScrollback ? `${ESC}[2J${ESC}[3J${ESC}[H` : ERASE_SCREEN);
  } catch {
    /* 写失败也无妨,调用方的 remount 仍会重绘 */
  }
}
