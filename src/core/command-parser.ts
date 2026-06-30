/** command-parser —— `/<tool> [target] -k v -k v` 命令字符串拆分。
 *
 *  与 agenteam ref 1:1。
 *
 *  语法：
 *    /<tool-name> [target] -param1 value1 -param2 value2
 *
 *  - 不以 `/` 开头 → 返回 null（caller 当成普通用户文本）
 *  - target 缺省 = "/" 表示「当前 agent」
 *  - 第一个非 `-` 开头的 token 是 target；其余按 -key value 解析（缺值 = "true"）
 *  - 引号支持：单 / 双引号包住的整段当一个 token */

export interface ParsedCommand {
  toolName: string;
  /** "/" = 当前 agent；其它字符串视作目标 agent 标识。 */
  target: string;
  args: Record<string, string>;
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const tokens = tokenize(trimmed.slice(1));
  if (tokens.length === 0) return null;

  const toolName = tokens[0];
  let target = "/";
  let argStart = 1;

  if (tokens.length > 1 && !tokens[1].startsWith("-")) {
    target = tokens[1];
    argStart = 2;
  }

  const args: Record<string, string> = {};
  for (let i = argStart; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      const key = token.replace(/^-+/, "");
      const value = i + 1 < tokens.length && !tokens[i + 1].startsWith("-")
        ? tokens[++i]
        : "true";
      args[key] = value;
    }
  }

  return { toolName, target, args };
}

/** Tokenize respecting single / double quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}
