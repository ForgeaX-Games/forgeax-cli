/**
 * shell-marks —— 终端 shell-integration 标记(FinalTerm OSC 133)。
 *
 * 让宿主终端(VS Code / iTerm2 / WezTerm / kitty / Ghostty / Windows Terminal)把每条
 * **已提交的用户输入**识别为一个 "command",从而免费获得:sticky scroll 把当前这轮的
 * 用户输入置顶、点击 sticky / cmd+↑↓ 跳回对应输入、滚动条 command 标记。不支持的终端
 * 把 OSC 当 no-op 静默忽略,零副作用。
 *
 * 序列布局(全部随 user 消息文本在 `<Static>` 提交区一次性 emit;live 区**绝不发**——
 * 动态区每帧擦除重画,重发会让终端的 command 记账每帧重置。见 Transcript.tsx):
 *
 *   D;0   关上一条 command(首条时提前收口外层 shell 的当前命令 —— 有意接管,语义闭合)
 *   A     prompt start —— 跳转/置顶锚点,与 D 同一 write,落在用户输入首行
 *   `› `  prompt 前缀放 A..B 之间(sticky 序列化的是 buffer 整行,箭头随行显示)
 *   B     command 文本开始
 *   C     command 结束、output 开始 —— 放末行可见文本之后、补底色 padding 之前;
 *         其后的 assistant/tool 输出都归属本轮
 *
 * ⚠️ D 必须带 exit code(`D;0`):bare `D` 在 VS Code 里 exitCode===undefined,会被
 * cmd+↑/↓ 导航的 skipEmptyCommands 过滤器整体跳过(markNavigationAddon.ts),跳转失效。
 *
 * ⚠️ 标记是零宽转义序列,但本仓 `displayWidth`(text-width.ts)逐 code point 计宽、不识别
 * 转义 —— 标记**必须在 padToWidth 之后拼接**,绝不参与宽度计算。string-width / wrap-ansi /
 * ink 渲染管线对 BEL 终结的 OSC 全链路按零宽字节级保留(已实证)。
 *
 * Boundary(HOST 层):node(process.stdout / env)+ 无依赖,纯常量与谓词。
 */

const OSC133 = '\x1b]133;';
const BEL = '\x07'; // 终结符用 BEL:单字节;绝不用 C1 0x9C(与 UTF-8 冲突)

/** 关上一条(D;0)+ 开新 prompt(A)。拼在用户消息首行最前。 */
export const PROMPT_START = `${OSC133}D;0${BEL}${OSC133}A${BEL}`;
/** command 文本开始(B)。拼在首行 `› ` 前缀之后。 */
export const COMMAND_START = `${OSC133}B${BEL}`;
/** command 结束、output 开始(C)。拼在末行可见文本之后、padding 之前。 */
export const OUTPUT_START = `${OSC133}C${BEL}`;
/** 单独收口 open command(cleanRedraw 清屏前发:VS Code 拦截 2J 时会把视口内已提交的
 *  command 连记账一起清,不先收口会残留一条持陈旧 marker 的垃圾条目)。 */
export const COMMAND_CLOSE = `${OSC133}D;0${BEL}`;

/** 是否发标记:仅真 TTY(管道/日志里是纯噪声);FORGEAX_NO_SHELL_MARKS=1 显式关闭。 */
export function shellMarksEnabled(): boolean {
  return process.stdout.isTTY === true && process.env.FORGEAX_NO_SHELL_MARKS !== '1';
}
