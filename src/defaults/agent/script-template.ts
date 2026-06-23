// @desc Default ScriptAgent src/index.ts template content

/**
 * Returns the default content for a new ScriptAgent's `src/index.ts`.
 *
 * The generated file exports `start` (optional init) and `update` (event loop).
 */
export function defaultScriptTemplate(): string {
  return `\
// @desc ScriptAgent entry — event-driven automation
import type { AgentContext, Event } from '#src/core/types.js';

/** Called once when the agent starts. */
export async function start(ctx: AgentContext) {
  console.log(\`[\${ctx.agentId}] started\`);
}

/** Called each time new events arrive. */
export async function update(events: Event[], ctx: AgentContext) {
  for (const ev of events) {
    console.log(\`[\${ctx.agentId}] event: \${ev.type}\`);
  }
}
`;
}
