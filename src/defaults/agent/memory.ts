// @desc Default MEMORY.md template for new agents

export function defaultMemoryTemplate(agentId: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `# Memory — ${agentId}

_This file is the long-term facts store and knowledge graph navigation index for agent \`${agentId}\`._
_Use \`memory_search\` to query memories, \`memory_get\` to read a specific file._

## 关键事实与决策

_(在这里记录持久性事实、重要决策和约束)_

## 偏好与约定

_(记录工作习惯、代码风格、用户偏好等)_

## 知识图导航

_(记录 memories/knowledge/ 中重要笔记的入口链接，如 [[knowledge/architecture]])_

---
_最后更新: ${today}_
`;
}
