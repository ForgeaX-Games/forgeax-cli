// @desc 极简 ANSI 着色封装 —— 等价 chalk level 1（基本 16 色）。
//
// 不引外部依赖。所有方法都接受 string，包一层 ANSI 序列后原样返回。
// `displayChalk` 接口和 agenteam ref 的 chalk.bold/dim/red/... 对齐，
// 让工具的 formatDisplay 不感知差异。

type Colorize = (s: string) => string;

function wrap(open: string, close: string): Colorize {
  return (s) => `\u001b[${open}m${s}\u001b[${close}m`;
}

export const displayChalk = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  underline: wrap("4", "24"),

  black: wrap("30", "39"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  white: wrap("37", "39"),
  gray: wrap("90", "39"),
  grey: wrap("90", "39"),
};
