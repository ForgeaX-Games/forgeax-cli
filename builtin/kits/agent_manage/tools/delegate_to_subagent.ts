/** delegate_to_subagent — hand a task off to a teammate agent.
 *
 *  Single-message-fire-and-forget by design: the teammate's reply lands in
 *  *their own* chat tab (forgeax-studio surfaces each agent's stream in a
 *  separate tab). This tool returns a short ack telling the caller LLM
 *  exactly that, so root doesn't sit and wait for a reply that's never
 *  going to come back through its own bubble.
 *
 *  Auto-scaffold: if the named agent isn't in the tree yet, we look it up
 *  via `resolvePersonaForAgent` (plugin first, marketplace fallback) and
 *  call `ensureAgentScaffold` + `attachAgent` + `startAgent` — same pipe
 *  the chat-tab UI uses for `to:'<name>'`. After scaffold we briefly poll
 *  the tree for the new node so the EventBus queue is registered before
 *  we route the event (the AgentTree changes via FSWatcher debounced
 *  ~300ms, hence the wait).
 */

import type { ToolDefinition, ToolOutput, AgentContext, Event } from "../../../../src/core/types";
import { ensureAgentScaffold, isValidAgentName } from "../../../../src/core/agent-scaffold";
import { resolvePersonaForAgent } from "../../../../src/agents/loader";
import { getSessionManager } from "../../../../src/core/session-manager";

const SCAFFOLD_TIMEOUT_MS = 5000;
const SCAFFOLD_POLL_MS = 100;
const SCAFFOLD_GRACE_MS = 350;

// ─── Runaway / cycle guard ────────────────────────────────────────────────────

/** 纯函数：检查一次 delegation 是否应该被拦截。
 *
 *  block=true 的三种情形：
 *  1. target 已经有一个未完成的 pending delegation（target busy）。
 *  2. 当前 session 并发委托数 >= maxConcurrent（默认 8）。
 *  3. 循环（delegator === target，或 delegator 以 target+"/" 开头，即子 agent
 *     往祖先 agent 委托，会形成 A→B→A 的 ping-pong）。
 *
 *  导出为 pure helper，方便单测不依赖任何 IO。 */
export function delegationGuard(opts: {
  delegations: Map<string, { delegator: string }>;
  delegator: string;
  target: string;
  maxConcurrent?: number;
}): { block: boolean; reason?: string } {
  const { delegations, delegator, target, maxConcurrent = 8 } = opts;

  // 1) target 已经有未完成的 pending delegation
  if (delegations.has(target)) {
    return { block: true, reason: `agent '${target}' already has an outstanding pending delegation (target busy)` };
  }

  // 2) 并发委托数超限
  if (delegations.size >= maxConcurrent) {
    return { block: true, reason: `too many concurrent delegations (${delegations.size} >= ${maxConcurrent})` };
  }

  // 3) 循环检测：delegator 与 target 相同，或 delegator 是 target 的子孙
  if (delegator === target || delegator.startsWith(target + "/")) {
    return { block: true, reason: `cycle detected: '${delegator}' delegating to ancestor '${target}'` };
  }

  return { block: false };
}

async function waitForTreeNode(ctx: AgentContext, agentId: string): Promise<boolean> {
  const deadline = Date.now() + SCAFFOLD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ctx.tree.get(agentId)) return true;
    await new Promise((r) => setTimeout(r, SCAFFOLD_POLL_MS));
  }
  return false;
}

export default {
  name: "delegate_to_subagent",
  description:
    "Hand a task off to a teammate agent (mochi, rin, …). The teammate " +
    "has its own persona, skills, tools, memory, and chat tab — your " +
    "message becomes their next user_input and their reply streams into " +
    "their tab, not yours. Use this whenever the user says \"ask X to …\", " +
    "\"let X do …\", or otherwise wants another agent involved. If the " +
    "teammate isn't active yet they're auto-spawned on first call. " +
    "Returns a short ack — do NOT wait for or quote their reply.",
  guidance:
    "**delegate_to_subagent**: This is the ONLY way to involve another " +
    "agent from inside an LLM turn. Don't grep the filesystem looking for " +
    "their name. Call `list_subagents` first if you're unsure who's " +
    "available.",
  input_schema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Teammate id (e.g. 'mochi', 'rin'). Must be a registered agent " +
          "id from the roster slot or `list_subagents`. Single segment, " +
          "no slashes.",
      },
      message: {
        type: "string",
        description:
          "The task / question for the teammate. Write it as if you were " +
          "the user typing in their chat tab — they'll reply in their own " +
          "voice, not yours.",
      },
    },
    required: ["agent", "message"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const agentId = String(args.agent ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!agentId) return "Error: missing 'agent' (teammate id).";
    if (!message) return "Error: missing 'message' to send.";
    if (!isValidAgentName(agentId)) {
      return `Error: invalid agent id '${agentId}' — must be a single name segment (letters/digits/dash/underscore).`;
    }
    if (agentId === ctx.agentPath || ctx.agentPath.endsWith(`/${agentId}`)) {
      return `Error: cannot delegate to self ('${agentId}').`;
    }

    // 1) Scaffold + attach if not yet in the tree.
    const sid = ctx.tree.sid;
    if (!ctx.tree.get(agentId)) {
      const persona = await resolvePersonaForAgent(agentId);
      if (!persona) {
        return (
          `Error: no agent registered with id '${agentId}'. ` +
          `Call list_subagents to see who's available.`
        );
      }
      const overrides: Record<string, unknown> = {
        personaFile: persona.personaPath,
        ...(persona.memoryDir ? { memoryDir: persona.memoryDir } : {}),
      };
      if (persona.tools && persona.tools.length > 0) {
        overrides.kits = { config: { "host-tools": { allow: persona.tools } } };
      }
      await ensureAgentScaffold(sid, agentId, {
        agentType: "conscious",
        overrides,
      });
      const session = getSessionManager().peek(sid);
      if (!session) {
        return `Error: session ${sid} is no longer open — cannot delegate.`;
      }
      await session.scheduler.attachAgent(agentId);
      await session.scheduler.startAgent(agentId);
      const ok = await waitForTreeNode(ctx, agentId);
      if (!ok) {
        return (
          `Error: scaffolded '${agentId}' but its tree node never appeared ` +
          `within ${SCAFFOLD_TIMEOUT_MS}ms — fs-watcher may be lagging. ` +
          `Try again.`
        );
      }
      // Brief grace for scheduler.attachAgent's queue registration to settle.
      await new Promise((r) => setTimeout(r, SCAFFOLD_GRACE_MS));
    }

    // 2) Runaway / cycle guard — check BEFORE routing the event or registering
    //    the pending delegation entry. A blocked call returns a clear error
    //    without touching the event bus.
    {
      const guardSession = getSessionManager().peek(sid);
      if (guardSession) {
        const check = delegationGuard({
          delegations: guardSession.delegations,
          delegator: ctx.agentPath,
          target: agentId,
        });
        if (check.block) {
          return `Error: delegation blocked — ${check.reason}`;
        }
      }
    }

    // 3) Route as user_input — same shape `/api/sessions/:sid/messages` emits
    //    when the chat tab targets a sub-agent.
    const event: Event = {
      source: "agent",
      type: "user_input",
      payload: {
        content: message,
        originAgent: ctx.agentPath,
        delegatedBy: ctx.agentPath,
      },
      to: agentId,
      handoff: "turn",
      ts: Date.now(),
    };
    ctx.eventBus.emit(event, ctx.agentPath);

    // 4) Register a pending delegation so Session._bindDelegationCallback can
    // auto-deliver a completion message back to the delegator on the
    // teammate's first hook:turnEnd. Mirrors agentic_os MessageBus
    // auto-deliver pattern (sub-agent → parent on turn-end). Without this
    // the delegator never learns the sub-agent finished.
    const callbackSession = getSessionManager().peek(sid);
    if (callbackSession) {
      callbackSession.delegations.set(agentId, {
        delegator: ctx.agentPath,
        brief: message.length > 80 ? message.slice(0, 80) + "…" : message,
        ts: Date.now(),
      });
    }

    return (
      `Delegated to ${agentId}. Their reply will stream into the ${agentId} ` +
      `chat tab — the user can switch tabs to read it. When ${agentId} ` +
      `finishes the turn, you'll automatically receive a short completion ` +
      `note as your next inbound message; do NOT wait for or quote their ` +
      `reply here, just acknowledge the handoff.`
    );
  },
  compactResult(args) {
    return `[delegate_to_subagent agent="${args.agent}"]`;
  },
  formatDisplay(args) {
    const agent = String(args.agent ?? "?");
    const msg = String(args.message ?? "");
    const preview = msg.length > 60 ? msg.slice(0, 60) + "…" : msg;
    return `→ ${agent}: ${preview}`;
  },
  serial: true,
} satisfies ToolDefinition;
