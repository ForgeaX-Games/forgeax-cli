import type { ToolDefinition } from '../core/types';
import { resolveTool } from '../kits/tool/tool-executor';
import { resolveToolDescriptorByWireName } from '../tools/registry';

const hostToolIds = new WeakMap<ToolDefinition, string>();

export function markHostToolDefinition<T extends ToolDefinition>(
  tool: T,
  hostToolId: string,
): T {
  hostToolIds.set(tool, hostToolId);
  return tool;
}

export function shouldDelegateHostToolConfirmation(
  wireName: string,
  tools: ToolDefinition[],
): boolean {
  const actualTool = resolveTool(wireName, tools);
  if (!actualTool) return false;
  const hostToolId = hostToolIds.get(actualTool);
  if (!hostToolId) return false;
  const descriptor = resolveToolDescriptorByWireName(wireName);
  if (!descriptor || descriptor.id !== hostToolId) return false;
  if (!descriptor.exposedToAI || !descriptor.hasHandler) return false;
  return descriptor.requireConfirm === 'always' || descriptor.requireConfirm === 'destructive';
}
