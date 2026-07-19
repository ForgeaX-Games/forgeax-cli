/**
 * Builtin search tools (②) — `grep` / `glob`.
 *
 * 二者皆 **只读 + 并发安全**。
 *
 * grep/glob 常见实现直接 spawn ripgrep / fast-glob；core ② **不**直接 spawn(boundary)，
 * 也不依赖外部包——改为经注入的 `SandboxFs`(inject C3 §4.5) 异步、有界地遍历
 * 文件树，自带 glob→RegExp 转换 + 内容正则匹配。功能子集覆盖常用形态(pattern/
 * path/glob/output_mode/head_limit)，重活(ripgrep 全部 flag) 留给 host 覆盖实现。
 *
 * Boundary: 仅 import core-local 契约 + node:。
 */
import type { SandboxFs, DirEnt } from '../../inject/types';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type ToolContext } from '../types';
import { requireSandboxFs } from './file-tools';

const DEFAULT_HEAD_LIMIT = 250;
/** 遍历守卫：按访问条目数封顶，零命中目录树也必须有确定上界。 */
export const MAX_WALK_ENTRIES = 20_000;
/** 总是跳过的目录(对齐 ripgrep 默认忽略的重目录)。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

// ─── glob → RegExp ───────────────────────────────────────────────────────────

/** 把一个 glob 片段(单段，不含 `/`)转成正则源码。支持 `*` `?` `[...]` `{a,b}`。 */
function globSegmentToRegex(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '.' || c === '+' || c === '(' || c === ')' || c === '^' || c === '$' || c === '|' || c === '\\')
      out += '\\' + c;
    else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else if (c === '[') out += '[';
    else if (c === ']') out += ']';
    else out += c;
  }
  return out;
}

/** 整条 glob(可含 `/` 与 `**`)→ RegExp(匹配相对路径，全段)。 */
export function globToRegExp(glob: string): RegExp {
  const parts = glob.split('/');
  const compiled = parts
    .map((p) => (p === '**' ? '.*' : globSegmentToRegex(p)))
    .join('/')
    // `**/` → 允许 0 段或多段
    .replace(/\.\*\//g, '(?:.*/)?');
  return new RegExp('^' + compiled + '$');
}

// ─── 递归遍历(经 SandboxFs.readDir) ─────────────────────────────────────────

interface WalkHit {
  /** 相对 root 的 posix 路径。 */
  rel: string;
  /** 绝对路径(root + rel)。 */
  abs: string;
}

interface WalkResult {
  hits: WalkHit[];
  /** 达到访问条目上限，目录树只扫描了一部分。 */
  truncated: boolean;
}

function joinPath(a: string, b: string): string {
  if (a === '') return b;
  return a.endsWith('/') ? a + b : a + '/' + b;
}

function abortError(): Error {
  const error = new Error('search aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/** 等待异步 IO 时也响应取消；底层 IO 可自行收尾，但工具调用不再被它拖住。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** 异步深度遍历；按访问条目数封顶，filterRel 仅决定是否收集。 */
async function walkFiles(
  fs: SandboxFs,
  root: string,
  filterRel: ((rel: string) => boolean) | null,
  signal: AbortSignal,
): Promise<WalkResult> {
  const hits: WalkHit[] = [];
  const stack: string[] = [''];
  let visitedEntries = 0;

  while (stack.length > 0) {
    throwIfAborted(signal);
    if (visitedEntries >= MAX_WALK_ENTRIES) return { hits, truncated: true };
    const relDir = stack.pop() as string;
    const absDir = relDir === '' ? root : joinPath(root, relDir);
    if (typeof fs.readDir !== 'function') throw new Error('search: sandboxFs.readDir is missing');
    const iterator = fs.readDir(absDir)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await abortable(Promise.resolve(iterator.next()), signal);
        if (next.done) break;
        if (visitedEntries >= MAX_WALK_ENTRIES) return { hits, truncated: true };
        const ent = next.value;
        visitedEntries++;
        const childRel = joinPath(relDir, ent.name);
        if (ent.isDir) {
          if (SKIP_DIRS.has(ent.name)) continue;
          stack.push(childRel);
        } else if (ent.isFile && (filterRel === null || filterRel(childRel))) {
          hits.push({ rel: childRel, abs: joinPath(root, childRel) });
        }
      }
    } catch (error) {
      throwIfAborted(signal);
      continue; // 不可读目录 → 跳过(只读工具不应炸)
    } finally {
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
    }
  }
  return { hits, truncated: false };
}

function resolveRoot(ctx: ToolContext, path?: string): string {
  if (path && path !== '') return path;
  const cwd = (ctx as ToolContext & { cwd?: string }).cwd;
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  return '.';
}

function clampHead<T>(arr: T[], headLimit?: number): T[] {
  const n = headLimit === undefined ? DEFAULT_HEAD_LIMIT : headLimit;
  if (n <= 0) return arr; // 0 = unlimited（head_limit:0）
  return arr.slice(0, n);
}

// ─── glob ────────────────────────────────────────────────────────────────────

export interface GlobInput {
  pattern: string;
  /** 搜索根目录。省略=ctx.cwd 或 "."。 */
  path?: string;
  head_limit?: number;
}

export interface GlobOutput {
  files: string[];
  truncated: boolean;
}

export function globTool(): AgentTool<GlobInput, GlobOutput> {
  return buildTool<GlobInput, GlobOutput>({
    name: 'glob',
    aliases: ['Glob'],
    searchHint: 'find files by glob pattern',
    inputJSONSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: {
          type: 'string',
          description: 'The directory to search in. Defaults to the current working directory.',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N entries. Defaults to 250. Pass 0 for unlimited.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    maxResultSizeChars: 100_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    interruptBehavior: () => 'cancel',
    async call(input, ctx): Promise<{ data: GlobOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.pattern !== 'string' || input.pattern === '') {
        throw new Error('glob: pattern must be a non-empty string');
      }
      const root = resolveRoot(ctx, input.path);
      const re = globToRegExp(input.pattern);
      const walked = await walkFiles(fs, root, (rel) => re.test(rel), ctx.signal);
      const all = walked.hits.map((h) => h.abs).sort();
      const files = clampHead(all, input.head_limit);
      return { data: { files, truncated: walked.truncated || files.length < all.length } };
    },
    mapResult(output, toolUseId): CoreEvent {
      return {
        type: CoreEventType.ToolCallResult,
        payload: {
          toolUseId,
          isError: false,
          files: output.files,
          count: output.files.length,
          truncated: output.truncated,
        },
        ts: Date.now(),
      };
    },
    renderToolUseMessage: (input) => `Globbing ${input.pattern}`,
  });
}

// ─── grep ────────────────────────────────────────────────────────────────────

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export interface GrepInput {
  pattern: string;
  /** 搜索根目录或单个文件。省略=ctx.cwd 或 "."。 */
  path?: string;
  /** 仅匹配此 glob 的文件(rg --glob)。 */
  glob?: string;
  /** 输出模式，默认 files_with_matches。 */
  output_mode?: GrepOutputMode;
  /** 大小写不敏感(rg -i)。 */
  '-i'?: boolean;
  /** content 模式显示行号(默认 true)。 */
  '-n'?: boolean;
  head_limit?: number;
}

export interface GrepContentLine {
  file: string;
  lineNumber: number;
  line: string;
}

export interface GrepOutput {
  mode: GrepOutputMode;
  /** content 模式。 */
  matches?: GrepContentLine[];
  /** files_with_matches 模式。 */
  files?: string[];
  /** count 模式：file → 命中行数。 */
  counts?: Array<{ file: string; count: number }>;
  truncated: boolean;
  /**
   * 降级标注:pattern 非法正则时,工具**不 throw**(不当失败点),而是返回空结果并附此字段,
   * 让模型看到「发生了降级 + 为什么 + 怎么自纠」。原则:工具本身不应成为失败点。
   */
  degraded?: { reason: string; hint: string };
}

export function grepTool(): AgentTool<GrepInput, GrepOutput> {
  return buildTool<GrepInput, GrepOutput>({
    name: 'grep',
    aliases: ['Grep'],
    searchHint: 'search file contents by regex',
    inputJSONSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regular expression pattern to search for in file contents',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to the current working directory.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}").',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description:
            'Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".',
        },
        '-i': { type: 'boolean', description: 'Case insensitive search' },
        '-n': {
          type: 'boolean',
          description: 'Show line numbers in content mode. Defaults to true.',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N entries. Defaults to 250. Pass 0 for unlimited.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    maxResultSizeChars: 20_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    interruptBehavior: () => 'cancel',
    async call(input, ctx): Promise<{ data: GrepOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.pattern !== 'string' || input.pattern === '') {
        throw new Error('grep: pattern must be a non-empty string');
      }
      const mode: GrepOutputMode = input.output_mode ?? 'files_with_matches';
      const flags = input['-i'] ? 'i' : '';
      // 正则编译失败 → 软失败:不 throw,返回空结果 + degraded 标注(带自纠引导语)。
      // 不做「字面子串兜底」——对 alternation(`a|b`)/字符类等最常见的非法输入,整串字面匹配
      // 几乎必然零命中,反而更误导;显式空+引导语才真正避免把工具变成「不当失败点」。
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, flags);
      } catch (err) {
        const reason = `pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`;
        const hint =
          '疑似正则过度转义(如 "\\\\[" 应为 "\\["),或特殊字符被 JSON 双重转义;修正 pattern 后重试。若只想按字面搜索,请转义正则元字符。';
        const empty: GrepOutput = { mode, truncated: false, degraded: { reason, hint } };
        if (mode === 'content') empty.matches = [];
        else if (mode === 'count') empty.counts = [];
        else empty.files = [];
        return { data: empty };
      }
      const showLineNumbers = input['-n'] !== false;

      // 解析搜索目标：单文件 vs 目录树。
      const root = resolveRoot(ctx, input.path);
      let targets: WalkHit[];
      let walkTruncated = false;
      if (input.path && input.path !== '' && fs.existsSync(input.path) && fs.statSync(input.path).isFile) {
        targets = [{ rel: input.path, abs: input.path }];
      } else {
        const globRe = input.glob ? globToRegExp(input.glob) : null;
        const walked = await walkFiles(
          fs,
          root,
          (rel) => {
            if (!globRe) return true;
            // glob 既匹配整相对路径，也匹配 basename(常见 "*.ts" 写法)。
            const base = rel.split('/').pop() as string;
            return globRe.test(rel) || globRe.test(base);
          },
          ctx.signal,
        );
        targets = walked.hits;
        walkTruncated = walked.truncated;
      }

      const contentMatches: GrepContentLine[] = [];
      const fileSet: string[] = [];
      const counts: Array<{ file: string; count: number }> = [];

      for (const t of targets) {
        throwIfAborted(ctx.signal);
        let text: string;
        try {
          text = await abortable(fs.readText(t.abs), ctx.signal);
        } catch {
          throwIfAborted(ctx.signal);
          continue; // 二进制/不可读 → 跳过
        }
        const lines = text.split('\n');
        let fileCount = 0;
        for (let i = 0; i < lines.length; i++) {
          if (i % 1_000 === 0) throwIfAborted(ctx.signal);
          // 每行独立测试(non-global regex，避免 lastIndex 状态)。
          if (re.test(lines[i])) {
            fileCount++;
            if (mode === 'content') {
              contentMatches.push({ file: t.abs, lineNumber: i + 1, line: lines[i] });
            }
          }
        }
        if (fileCount > 0) {
          fileSet.push(t.abs);
          if (mode === 'count') counts.push({ file: t.abs, count: fileCount });
        }
      }

      if (mode === 'content') {
        const clamped = clampHead(contentMatches, input.head_limit);
        void showLineNumbers; // 行号始终在结构化结果里(showLineNumbers 仅影响渲染)
        return {
          data: { mode, matches: clamped, truncated: walkTruncated || clamped.length < contentMatches.length },
        };
      }
      if (mode === 'count') {
        const sorted = counts.sort((a, b) => a.file.localeCompare(b.file));
        const clamped = clampHead(sorted, input.head_limit);
        return { data: { mode, counts: clamped, truncated: walkTruncated || clamped.length < sorted.length } };
      }
      const sortedFiles = fileSet.sort();
      const clampedFiles = clampHead(sortedFiles, input.head_limit);
      return {
        data: { mode, files: clampedFiles, truncated: walkTruncated || clampedFiles.length < sortedFiles.length },
      };
    },
    mapResult(output, toolUseId): CoreEvent {
      const payload: Record<string, unknown> = {
        toolUseId,
        isError: false,
        mode: output.mode,
        truncated: output.truncated,
      };
      if (output.mode === 'content') {
        payload.matches = output.matches ?? [];
        payload.count = output.matches?.length ?? 0;
      } else if (output.mode === 'count') {
        payload.counts = output.counts ?? [];
        payload.count = output.counts?.length ?? 0;
      } else {
        payload.files = output.files ?? [];
        payload.count = output.files?.length ?? 0;
      }
      // 降级标注随结果回灌给模型(toolResultContent 会整体 JSON 化 payload)。
      if (output.degraded) payload.degraded = output.degraded;
      return { type: CoreEventType.ToolCallResult, payload, ts: Date.now() };
    },
    renderToolUseMessage: (input) => `Grepping ${input.pattern}`,
  });
}
