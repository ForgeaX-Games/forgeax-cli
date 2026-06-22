// @desc Create a new agent with optional template and parent inheritance
import type { ToolDefinition, ToolOutput, AgentRole } from "#src/core/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT_ENTRY_SEGMENTS } from "#src/core/script-agent.js";

const VALID_ROLES = new Set<AgentRole>(["admin", "steward", "worker"]);

export default {
  name: "create_agent",
  description:
    "Create a new agent: scaffold its directory with default templates and attach it to the agent tree. " +
    "Optionally specify a parent to create it as a child node, a role to override the default assignment, " +
    "and a template to initialize from (resolved across agent-local → team → instance layers).",
  guidance:
    "When creating a subordinate (child of current agent), consider `fill_from_parent: true` " +
    "to seed SOUL.md / PRINCIPLE.md / agent.json from yourself — a shared family voice is usually " +
    "a better starting point than the generic default, and you can still tweak the files afterwards. " +
    "Use `merge_parent_agent_json: true` when you want to also inherit model/capability settings.",
  input_schema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "Unique ID for the new agent",
      },
      parent_id: {
        type: "string",
        description: "Parent agent ID — the new agent becomes a child of this node (omit for root-level)",
      },
      role: {
        type: "string",
        enum: ["admin", "steward", "worker"],
        description: "Explicit role (omit to auto-assign: first root → admin, additional root → steward, child → worker)",
      },
      template: {
        type: "string",
        description: "Template name to initialize from (e.g. 'observe', 'act'). Resolved across agent-local → team → instance layers. Omit for default scaffold.",
      },
      fill_from_parent: {
        type: "boolean",
        description: "Non-destructively copy all of parent's agent dir files (SOUL/PRINCIPLE/agent.json/capabilities/…) into the new agent. Default: false.",
      },
      merge_parent_agent_json: {
        type: "boolean",
        description: "Deep-merge parent's agent.json into the new agent's (current wins on conflicts). Default: false.",
      },
      agent_type: {
        type: "string",
        enum: ["conscious", "script"],
        description: "Scaffold style: 'conscious' (default, scaffolds SOUL/PRINCIPLE) or 'script' (scaffolds src/index.ts). Note: runtime type is determined by src/index.ts existence, not this hint.",
      },
    },
    required: ["agent_id"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const tree = ctx.tree;
    const agentId = String(args.agent_id).trim();
    const parentId = args.parent_id != null ? String(args.parent_id).trim() : undefined;
    const role = args.role != null ? String(args.role).trim() as AgentRole : undefined;
    const template = args.template != null ? String(args.template).trim() : undefined;
    const fillFromParent = args.fill_from_parent === true;
    const mergeParentAgentJson = args.merge_parent_agent_json === true;
    const agentType = args.agent_type === "script" ? "script" as const : "conscious" as const;

    if (!agentId) return "agent_id is required.";
    if (tree.has(agentId)) return `Agent '${agentId}' already exists.`;
    if (parentId && !tree.has(parentId)) return `Parent '${parentId}' not found in tree.`;
    if (role && !VALID_ROLES.has(role)) return `Invalid role '${role}'. Must be: admin, steward, worker.`;

    const result = await tree.create({
      id: agentId,
      parentId: parentId ?? null,
      role,
      template,
      emitterId: ctx.agentId,
      fillFromParent,
      mergeParentAgentJson,
      agentType,
    });

    if (!result.ok) return result.error;

    const node = tree.getNode(agentId);
    const parentInfo = node?.parentId ? ` under '${node.parentId}'` : " as root";
    const templateInfo = template ? ` from template '${template}'` : "";
    const agentDir = ctx.pathManager.agent(agentId).root();
    const isScript = existsSync(join(agentDir, ...SCRIPT_ENTRY_SEGMENTS));
    const typeLabel = isScript ? " (ScriptAgent)" : "";
    const editHint = isScript ? "Edit src/index.ts to implement." : "Edit SOUL.md and agent.json to customize.";
    return `Agent '${agentId}' created [${node?.role}]${parentInfo}${templateInfo}${typeLabel}. ${editHint}`;
  },
} satisfies ToolDefinition;
