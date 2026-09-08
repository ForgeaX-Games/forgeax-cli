/**
 * Post-compact rehydration (Stream F / #13,简化版) — 压缩后把"最近读过的文件"重新挂回。
 *
 * 压缩会把历史摘成一段文字,模型容易"忘了刚在改哪个文件"。本模块做**最小重挂**:
 * 取 read-tracker 最近读的 maxFiles 个文件(默认 1),重读、按 tokenBudget(默认 10k)head 截断,
 * 产出 attachment 消息(由 host/管线附在摘要**之后**)。不碰 plan/skill/图二进制(简化,#13)。
 *
 * 优雅降级:无最近文件 / 读失败 / 超预算 → 跳过该文件,绝不抛崩。
 * 纯逻辑 + 注入 readFile(无直接 IO)。Boundary: 仅 import core-local 类型。
 */
import type { ProviderMessage } from '../provider/types';
import type { SandboxFs } from '../inject/types';
import {
  DEFAULT_REHYDRATE_MAX_FILES,
  DEFAULT_REHYDRATE_TOKEN_BUDGET,
  RECOMMENDED_REHYDRATE_MAX_FILES,
  RECOMMENDED_REHYDRATE_TOKEN_BUDGET,
  type RehydrateInput,
  type RehydrateResult,
} from './compaction-types';

/** 粗估 token(~4 char/token)。 */
function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** 压后重挂的 host 注入配置(= CompactionV2Options.rehydrate 的形状,recentReadPaths 省略)。 */
export interface RehydrateInjection {
  readFile: (path: string) => Promise<string>;
  tokenBudget: number;
  maxFiles: number;
}

/**
 * D-01:从 toolContext 组装压后重挂注入(三 host 统一入口,SSOT)。
 *   - readFile = toolContext.sandboxFs.readText(host 已注入 NodeSandboxFs)。
 *   - 预算取推荐档(3 文件 / 25k);host 拿回后可按需覆写。
 *   - **不**给 recentReadPaths → loop 自取内部 read-tracker(host 无法访问 per-run tracker)。
 * sandboxFs 缺失(理论上不该发生)→ readFile reject,rehydrate() 逐文件 catch 降级(fail-open)。
 */
export function makeRehydrateInjection(toolContext: Record<string, unknown>): RehydrateInjection {
  const fs = toolContext.sandboxFs as Pick<SandboxFs, 'readText'> | undefined;
  return {
    readFile: (path: string): Promise<string> =>
      fs ? fs.readText(path) : Promise.reject(new Error('no sandboxFs for rehydrate')),
    tokenBudget: RECOMMENDED_REHYDRATE_TOKEN_BUDGET,
    maxFiles: RECOMMENDED_REHYDRATE_MAX_FILES,
  };
}

/** 把内容 head 截断到 ≤ budget token(超出则尾部加省略标记)。 */
function headTruncate(content: string, budgetTokens: number): string {
  const maxChars = budgetTokens * 4;
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n\n... [truncated for post-compact rehydration] ...';
}

function throwIfRehydrateAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'rehydration aborted');
  error.name = 'AbortError';
  throw error;
}

/** Race an injected filesystem read against turn cancellation. The read may
 * not support AbortSignal itself, so cancellation must not wait for it to
 * settle. Promise handlers remain attached to consume a late rejection. */
function readFileWithAbort(
  readFile: RehydrateInput['readFile'],
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfRehydrateAborted(signal);
  if (!signal) return readFile(path);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        try {
          throwIfRehydrateAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let pending: Promise<string>;
    try {
      pending = readFile(path);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      (content) => finish(() => resolve(content)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * 压后重挂。返回 attachment 消息数组(可能为空)。
 *
 * 取 recentReadPaths 前 maxFiles 个,逐个重读 + head 截断 + token 预算累计(超预算即停)。
 */
export async function rehydrate(input: RehydrateInput): Promise<RehydrateResult> {
  throwIfRehydrateAborted(input.signal);
  const maxFiles = Math.max(0, input.maxFiles ?? DEFAULT_REHYDRATE_MAX_FILES);
  const budget = Math.max(0, input.tokenBudget ?? DEFAULT_REHYDRATE_TOKEN_BUDGET);
  const outcomes = {
    requested: input.recentReadPaths.length,
    attempted: 0,
    attached: 0,
    failed: 0,
    skippedByLimit: 0,
    skippedByBudget: 0,
  };
  if (maxFiles === 0 || budget === 0 || input.recentReadPaths.length === 0) {
    if (maxFiles === 0) outcomes.skippedByLimit = outcomes.requested;
    else if (budget === 0) outcomes.skippedByBudget = outcomes.requested;
    return { attachments: [], outcomes };
  }

  const attachments: ProviderMessage[] = [];
  let spent = 0;
  let used = 0;

  for (let index = 0; index < input.recentReadPaths.length; index++) {
    throwIfRehydrateAborted(input.signal);
    if (used >= maxFiles) {
      outcomes.skippedByLimit = input.recentReadPaths.length - index;
      break;
    }
    if (spent >= budget) {
      outcomes.skippedByBudget = input.recentReadPaths.length - index;
      break;
    }
    const path = input.recentReadPaths[index]!;
    outcomes.attempted++;
    let content: string;
    try {
      content = await readFileWithAbort(input.readFile, path, input.signal);
      throwIfRehydrateAborted(input.signal);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      outcomes.failed++;
      continue; // 读失败 → 跳过(降级)
    }
    const remaining = budget - spent;
    const body = headTruncate(content, remaining);
    const text =
      `[Re-attached after compaction — most recently read file]\n` +
      `File: ${path}\n\n${body}`;
    attachments.push({
      role: 'user',
      content: text,
      // marker 供下游识别(非模型语义)。
      ...({ _rehydrated: true, _rehydratedPath: path } as Record<string, unknown>),
    } as ProviderMessage);
    spent += estTokens(text);
    used++;
    outcomes.attached++;
  }

  throwIfRehydrateAborted(input.signal);
  return { attachments, outcomes };
}
