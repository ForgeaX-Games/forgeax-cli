/** @desc Standalone tool dispatch function, extracted from agent.ts agent loop */

import type { ToolDefinition, AgentContext } from "../../core/types.js";
import { withModelFeedback } from "../../core/logger.js";
import { findByName } from "../../registries/name-lookup.js";

const DEFAULT_MAX_RESULT_CHARS = 256_000;

function truncateResult(raw: string, limit: number): string {
  if (raw.length <= limit) return raw;
  const removed = raw.length - limit;
  return raw.slice(0, limit) +
    `\n\n[result truncated — ${(removed / 1024).toFixed(0)} KB removed]`;
}

/**
 * Look up a tool by qualified-or-bare-when-unique name.
 *
 * Delegates to the shared `findByName` so list-based callers (here) and
 * Map-based callers (BaseRegistry) follow identical resolution rules.
 */
export function resolveTool(name: string, tools: ToolDefinition[]): ToolDefinition | undefined {
  return findByName(tools, name);
}

/** Execute a tool by name (supports both qualified and bare name lookup). */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tools: ToolDefinition[],
  ctx: AgentContext,
): Promise<unknown> {
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
    const finalResult = typeof result === "string" && maxChars !== Infinity
      ? truncateResult(result, maxChars)
      : result;

    const preview = typeof finalResult === "string"
      ? finalResult.slice(0, 200)
      : JSON.stringify(finalResult).slice(0, 200);
    console.debug(`tool:${name} → ${preview}`);
    return finalResult;
  } catch (err: any) {
    withModelFeedback(() => console.error(`tool:${name} failed: ${err?.message ?? err}`));
    return { error: err.message };
  }
}
