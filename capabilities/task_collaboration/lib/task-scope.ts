// @desc Resolve task.notify into concrete agent IDs (children_depth BFS + agentIds + groupIds).

import type { AgentTreeAPI } from "#src/core/types.js";
import type { TaskNotify } from "./task-types.js";

export interface NotifyResolution {
  /** Real agents that exist in the tree — receive board-tasks visibility / pushes. */
  realAgents: string[];
  /** IDs the notify referenced but were not found in the tree — passed through to extension hooks for downstream resolution. */
  extensionIds: string[];
  /** Channels passed through untouched for downstream plugins. */
  channels: string[];
}

/**
 * Resolve a notify spec to concrete recipients.
 * - children_depth: BFS expansion N levels of subtree rooted at `rootAgentId` (the issuer)
 * - agentIds: classified into realAgents (resolved via tree) vs extensionIds (not found)
 * - groupIds: expanded to current group members
 */
export function resolveNotify(
  notify: TaskNotify,
  tree: AgentTreeAPI,
  rootAgentId: string,
): NotifyResolution {
  const real = new Set<string>();
  const extension = new Set<string>();

  if (notify.children_depth > 0) {
    const queue: Array<{ id: string; depth: number }> = [{ id: rootAgentId, depth: 0 }];
    const seen = new Set<string>([rootAgentId]);
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= notify.children_depth) continue;
      for (const child of tree.getChildren(id)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        real.add(child.id);
        queue.push({ id: child.id, depth: depth + 1 });
      }
    }
  }

  for (const id of notify.agentIds ?? []) {
    if (id === rootAgentId) continue;
    if (tree.getNode(id)) real.add(id);
    else extension.add(id);
  }

  for (const gid of notify.groupIds ?? []) {
    for (const member of tree.getGroupMembers(gid)) {
      real.add(member.id);
    }
  }

  // Issuer should not appear in the notify resolution (issuer is on the work-circle, not the broadcast circle).
  real.delete(rootAgentId);

  return {
    realAgents: [...real],
    extensionIds: [...extension],
    channels: [...(notify.channels ?? [])],
  };
}
