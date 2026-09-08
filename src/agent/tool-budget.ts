import type { AgentTool, ProviderToolClass } from '../capability/types';

/** Strictest provider-compatible tool count supported by the core request boundary. */
export const DEFAULT_PROVIDER_TOOL_LIMIT = 128;

type ProviderBudgetTool = Pick<AgentTool, 'providerToolClass' | 'isMcp' | 'mcpInfo'>;

/**
 * Resolve the provider-budget class without guessing from a tool name.
 *
 * `providerToolClass` is the source-of-truth for priority: only an explicit
 * `builtin` value is protected. Missing or unknown classes fail safe as
 * non-builtin and therefore yield to built-ins. MCP markers remain a
 * defensive override for malformed/adapted tools that forgot the explicit
 * external-source class.
 */
export function providerToolClassOf(tool: ProviderBudgetTool): ProviderToolClass {
  if (tool.isMcp === true || tool.mcpInfo !== undefined) return 'non-builtin';
  return tool.providerToolClass === 'builtin' ? 'builtin' : 'non-builtin';
}

/**
 * Keep every builtin when possible, then keep non-builtin tools by their existing
 * order. If builtins alone exceed the limit, keep only the first builtins. The
 * returned sequence preserves the original order of all retained tools.
 */
export function applyProviderToolBudget<T extends ProviderBudgetTool>(tools: readonly T[]): T[] {
  if (tools.length <= DEFAULT_PROVIDER_TOOL_LIMIT) return [...tools];

  const classes = tools.map(providerToolClassOf);
  const builtinCount = classes.filter((kind) => kind === 'builtin').length;

  if (builtinCount > DEFAULT_PROVIDER_TOOL_LIMIT) {
    let builtinKept = 0;
    return tools.filter((_, index) => {
      if (classes[index] !== 'builtin') return false;
      builtinKept += 1;
      return builtinKept <= DEFAULT_PROVIDER_TOOL_LIMIT;
    });
  }

  let nonBuiltinBudget = DEFAULT_PROVIDER_TOOL_LIMIT - builtinCount;
  return tools.filter((_, index) => {
    if (classes[index] === 'builtin') return true;
    if (nonBuiltinBudget <= 0) return false;
    nonBuiltinBudget -= 1;
    return true;
  });
}
