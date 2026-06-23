// @desc agent_manage kit — inter-agent delegation primitives.
//
// Tools / slots in this kit let one agent (typically root/forge) hand work
// off to a teammate sub-agent (mochi, rin, …) by name. Without this kit the
// only entry point is the chat tab UI — root has no way to *talk to* mochi
// from inside its own LLM turn, which is why it ends up grepping for files
// named "mochi" when the user asks it to delegate.
//
// Always-on for builtin layer. Sub-agents that should not see delegation
// (single-shot specialists) can disable via agent.json::kits.disable: ["#agent_manage"].
import type { AgentContext } from "../../../src/core/types";

export default function condition(_ctx: AgentContext): boolean {
  return true;
}
