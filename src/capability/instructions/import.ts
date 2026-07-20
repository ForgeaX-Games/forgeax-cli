/**
 * `@import` 内联展开 —— 指令文件里的 `@path` 递归内联为目标文件内容。
 *
 * 语法(对齐 CC memory `@include` / Gemini CLI import):
 *   `@path` / `@./relative` / `@~/home/you` / `@/absolute` —— 无前缀按相对路径解析。
 *   token 出现在行首或空白之后才算 import(`foo@bar` 这类邮箱地址不误命中)。
 *   fenced code block(``` / ~~~)内的 `@path` 不展开(代码示例里的 @ 保持原样)。
 *
 * 护栏(装载器唯一守卫;三条硬约束):
 *   - **深度 ≤ MAX_IMPORT_DEPTH**:根文件 depth0,每层 import +1;超限的 import 不展开,
 *     原位留一行截断说明。
 *   - **单文件 ≤ MAX_FILE_CHARS**:任何单个文件(根 + 被 import)超过即截断并附说明。
 *   - **环检测**:沿当前展开链记录已访问绝对路径集;import 回已访问路径 → 跳过并留说明
 *     (不死循环)。
 *
 * 读文件走**装配期 node:fs**(assembly-time loader),不走 ctx.sandboxFs——那是 runtime
 * 工具用的注入接缝。readFile 可注入以便单测(纯内存 fixture)。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

/** import 递归的最大深度(根文件 = 0;第 5 层 import 起截断)。 */
export const MAX_IMPORT_DEPTH = 4;
/** 单文件字符封顶(根文件 + 每个被 import 文件各自适用)。 */
export const MAX_FILE_CHARS = 40_000;

/** `@path` 匹配:行首或空白之后的 `@`,path 允许转义空格(`\ `)。 */
const INCLUDE_RE = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

/** 默认读文件(装配期 node:fs,utf8)。 */
function defaultRead(abs: string): string {
  return readFileSync(abs, 'utf8');
}

export interface ExpandOptions {
  /** 已访问绝对路径集(环检测;沿链传递,含当前根)。 */
  visited?: Set<string>;
  /** 当前递归深度(0 = 顶层文件)。 */
  depth?: number;
  /** 文件读取器(默认 node:fs;单测可注入内存 fixture)。 */
  readFile?: (abs: string) => string;
}

/**
 * 把 `@import` token 解析为绝对路径;非 path-like(如 `@#foo`)→ null(不当 import)。
 * baseDir = 引用该 token 的文件所在目录(相对路径据此解析)。
 */
export function resolveImportPath(token: string, baseDir: string): string | null {
  const raw = token.replace(/\\ /g, ' '); // 反转义空格
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  if (isAbsolute(raw)) return raw;
  // 相对路径:首字符须是 [a-zA-Z0-9._/-],否则不像路径(排除 @# @% @* 等)。
  if (!/^[a-zA-Z0-9._/-]/.test(raw)) return null;
  return resolve(baseDir, raw);
}

/** 截断单文件到 MAX_FILE_CHARS 并附说明(仅当超限)。 */
function capFile(content: string, hint: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  return `${content.slice(0, MAX_FILE_CHARS)}\n[import truncated: ${hint} exceeded ${MAX_FILE_CHARS} chars]`;
}

/**
 * 展开一段内容里的 `@import`(内联替换)。fenced code block 内不展开。
 * 递归读取被 import 文件 → capFile → 再展开(depth+1、visited 追加)。
 */
export function expandImports(content: string, baseDir: string, opts: ExpandOptions = {}): string {
  const depth = opts.depth ?? 0;
  const visited = opts.visited ?? new Set<string>();
  const readFile = opts.readFile ?? defaultRead;

  let inFence = false;
  return content
    .split('\n')
    .map((line) => {
      // fenced code block 开合(``` 或 ~~~ 起头)——块内 @path 原样保留。
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      return line.replace(INCLUDE_RE, (whole, token: string) => {
        const lead = whole.slice(0, whole.length - 1 - token.length); // (^|\s) 前导
        const abs = resolveImportPath(token, baseDir);
        if (!abs) return whole; // 非 path-like → 不当 import,原样
        if (depth >= MAX_IMPORT_DEPTH) {
          return `${lead}[import skipped: max depth ${MAX_IMPORT_DEPTH} exceeded at @${token}]`;
        }
        if (visited.has(abs)) {
          return `${lead}[import skipped: cycle at @${token}]`;
        }
        let sub: string;
        try {
          sub = readFile(abs);
        } catch {
          return `${lead}[import skipped: @${token} not readable]`;
        }
        sub = capFile(sub, `@${token}`);
        const nextVisited = new Set(visited);
        nextVisited.add(abs);
        const expanded = expandImports(sub, dirname(abs), { visited: nextVisited, depth: depth + 1, readFile });
        return `${lead}${expanded}`;
      });
    })
    .join('\n');
}

/**
 * 读取并完整展开一个顶层指令文件。文件不可读 → 空串(优雅降级)。
 * 根文件先入 visited(自引用 / import-back 立即被环检测拦住)。
 */
export function loadAndExpand(absPath: string, readFile: (abs: string) => string = defaultRead): string {
  let raw: string;
  try {
    raw = readFile(absPath);
  } catch {
    return '';
  }
  raw = capFile(raw, absPath);
  const visited = new Set<string>([resolve(absPath)]);
  return expandImports(raw, dirname(absPath), { visited, depth: 0, readFile });
}
