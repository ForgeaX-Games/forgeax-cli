/** Tool dispatch —— `executeTool(name, args, tools, ctx)`：
 *
 *  1. 解析 name（qualified 优先，bare 唯一时回退）—— `findByName` 与
 *     BaseRegistry.resolveKey 共用同一套规则，避免双 lookup 出现歧义。
 *  2. condition 闸门（per-turn 可见性已在 base-loader wrap，但 tool 自带
 *     `condition` 也会被一并执行）。
 *  3. `validateInput`（可选）—— 返回字符串即视为校验失败，作为 error 返回。
 *  4. `tool.execute(args, ctx)` —— 真调用；string 输出按 `maxResultChars`
 *     截断（默认 256KB）。
 *  5. 任何 throw 转为 `{ error: msg }`，并触发 `withModelFeedback` 让 agent
 *     在 prompt 里看到错误（不让 silently swallowed）。
 *
 *  Ported from `agenteam-os-ref/src/capability/tool/tool-executor.ts`. */

import type { ToolDefinition, AgentContext, ToolOutput } from "../../core/types";
import { withModelFeedback } from "../../core/logger";
import { findByName } from "../name-lookup";

const DEFAULT_MAX_RESULT_CHARS = 256_000;

function truncateResult(raw: string, limit: number): string {
  if (raw.length <= limit) return raw;
  const removed = raw.length - limit;
  return raw.slice(0, limit) + `\n\n[result truncated — ${(removed / 1024).toFixed(0)} KB removed]`;
}

/** Look up a tool by qualified-or-bare-when-unique name. */
export function resolveTool(name: string, tools: ToolDefinition[]): ToolDefinition | undefined {
  return findByName(tools, name);
}

/** Execute a tool by name. Returns either the raw `ToolOutput` (string |
 *  ContentPart[]) on success, or `{ error: message }` on failure / missing /
 *  validation-fail / condition-blocked. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tools: ToolDefinition[],
  ctx: AgentContext,
): Promise<ToolOutput | { error: string }> {
  const tool = resolveTool(name, tools);
  if (!tool) return { error: `Unknown tool: ${name}` };
  if (tool.condition && !tool.condition(ctx, tool)) {
    return { error: `Tool "${name}" is not available in the current context` };
  }

  if (tool.validateInput) {
    const validationError = await tool.validateInput(args, ctx);
    if (validationError) return { error: validationError };
  }

  console.debug(`tool:${name}(${JSON.stringify(args).slice(0, 120)})`);

  try {
    const result = await tool.execute(args, ctx);
    const maxChars = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    const finalResult =
      typeof result === "string" && maxChars !== Infinity
        ? truncateResult(result, maxChars)
        : result;

    const preview =
      typeof finalResult === "string"
        ? finalResult.slice(0, 200)
        : JSON.stringify(finalResult).slice(0, 200);
    console.debug(`tool:${name} → ${preview}`);
    return finalResult;
  } catch (err: any) {
    withModelFeedback(() => console.error(`tool:${name} failed: ${err?.message ?? err}`));
    return { error: err?.message ?? String(err) };
  }
}
