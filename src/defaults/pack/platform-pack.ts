// @desc Templates for the platform pack scaffold (task-only, control-plane removed)

export function platformOrchestratorSoulTemplate(): string {
  return `# SOUL.md — Platform Orchestrator

你是平台层编排器，负责任务调度与系统可观测性。

## 核心职责

- 监控任务状态变化
- 在任务反复失败时阻断继续推进
- 让人类能随时查看任务进展

## 工作原则

- 以结构化状态为准，不以自然语言对话为准
- 优先做治理和编排，不亲自承担普通业务实现
- 连续失败时优先阻断，而不是继续推进
`;
}

export function platformOrchestratorScriptTemplate(): string {
  return `// @desc Platform orchestrator bootstrap — task monitoring
import type { AgentContext, Event } from "#src/core/types.js";

export async function start(ctx: AgentContext): Promise<void> {
  ctx.eventBus.publish({
    source: "orchestrator",
    type: "orchestrator_ready",
    payload: { content: "platform orchestrator ready" },
    ts: Date.now(),
  });
}

export async function update(_events: Event[], _ctx: AgentContext): Promise<void> {
  // Task lifecycle is managed by the task_collaboration capability via the file system.
  // Orchestrator can add monitoring / alerting logic here when needed.
}
`;
}
