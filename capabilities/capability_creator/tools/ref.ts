// @desc Unified reference docs reader — all capability authoring guides in one tool
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dir, "../docs");

const adminSlotsDir = join(__dir, "../../admin/slots");

const DOCS: Record<string, { path: string; summary: string }> = {
  tool_authoring:       { path: join(docsDir, "ref_tool_authoring.md"),       summary: "ToolDefinition fields, execute signature, ctx API, compactResult, condition patterns, return value convention" },
  content_part:         { path: join(docsDir, "ref_content_part.md"),         summary: "ContentPart unified multimedia format — all shapes, inline vs file-based, correct/incorrect examples, validation pipeline" },
  slot_authoring:       { path: join(docsDir, "ref_slot_authoring.md"),       summary: "SlotFactory, ContextSlot fields, sync content() canonical template with fs-bridge sync APIs, cacheHint + priority section model, template variables, isolation semantics" },
  plugin_authoring:     { path: join(docsDir, "ref_plugin_authoring.md"),     summary: "PluginSource lifecycle (start/stop), event observation, handoff modes, TeamBoard, timer patterns, config access" },
  agent_config:         { path: join(docsDir, "ref_agent_config.md"),         summary: "agent.json / agent-overrides.json two-layer config, all fields, capabilities.config, condition.ts triple export" },
  agent_context:        { path: join(docsDir, "ref_agent_context.md"),        summary: "AgentContext fields: agentId, signal, eventBus, teamBoard, pathManager, tree, hook, ledger, fs" },
  runtime_environment:  { path: join(docsDir, "ref_runtime_environment.md"),  summary: "[READ FIRST] Framework abstraction rules (child_process ban, ctx.fs, TerminalManager, PathManager, FSWatcher), host/container execution model, security boundaries" },
  evolve_checklist:     { path: join(adminSlotsDir, "evolve-checklist.md"),   summary: "Evolve mode development workflow: checklist, submit_mr, source navigation table, file conventions, changelog format" },
};

const docNames = Object.keys(DOCS);
const listing = docNames.map((k) => `- **${k}**: ${DOCS[k].summary}`).join("\n");

export default {
  name: "ref",
  description:
    "Show capability authoring reference docs. " +
    "Available: " + docNames.join(", ") + ". " +
    "Call without arguments to see the full list with summaries.",
  guidance:
    "**ref**: MUST read before creating or modifying capability code (tools/slots/plugins), " +
    "agent config (agent.json/condition.ts), or framework source (src/). " +
    "Reading order: runtime_environment FIRST (common rules), then the specific doc for your task. " +
    "Call ref() without args to see all available docs with summaries.",
  input_schema: {
    type: "object",
    properties: {
      doc: {
        type: "string",
        enum: docNames,
        description: "Which reference doc to show. Omit to list all available docs.",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolOutput> {
    const doc = args.doc as string | undefined;

    if (!doc) {
      return `Available reference docs (call ref with doc=<name>):\n\n**Reading order**: Start with \`runtime_environment\` (common rules for all capability code), then read the specific doc for your task.\n\n${listing}`;
    }

    const entry = DOCS[doc];
    if (!entry) {
      return `Unknown doc "${doc}". Available: ${docNames.join(", ")}`;
    }

    try {
      return getSandboxFs().readTextSync(entry.path);
    } catch (e: any) {
      return `Error reading ${doc}: ${e.message}`;
    }
  },
  serial: false,
} satisfies ToolDefinition;
