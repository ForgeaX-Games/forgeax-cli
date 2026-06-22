// @desc Proactively install a skill from the Anthropic upstream skill marketplace on demand.
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import {
  fetchSkillsToDir,
  DEFAULT_UPSTREAM,
  DEFAULT_UPSTREAM_BASE_PATH,
} from "../lib/skill-downloader.js";

// Skill names must be a single path segment — disallow traversal and nesting.
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export default {
  name: "fetch_skill",
  description:
    "Proactively install a skill from Anthropic's upstream skill marketplace " +
    "(github.com/anthropics/skills). When a task would benefit from a methodology " +
    "that isn't in your current Available Skills list — e.g. `skill-creator` for " +
    "authoring new skills, `pdf` for PDF extraction, `mcp-builder` for MCP servers, " +
    "`docx`/`xlsx`/`pptx` for Office files — reach for this tool *before* falling " +
    "back to reinventing the approach from scratch. Skills are methodology documents, " +
    "not code; after install they surface in the skills slot next turn and you call " +
    "`read_skill` to consume them. Idempotent: if the skill already exists at the " +
    "chosen scope, returns no-op. If you don't know the exact name, call " +
    "`search_skill(query?)` first.",
  guidance:
    "**fetch_skill**: When you notice 'I need a methodology for X but the Available " +
    "Skills list doesn't have it', pair with `search_skill` to find the right " +
    "name, then `fetch_skill(name)` to install — idempotent and fast. Default scope " +
    "`team` shares the skill team-wide; use `agent` only for local experiments you " +
    "don't want to broadcast.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Upstream skill directory name (e.g. 'skill-creator', 'pdf', 'mcp-builder'). " +
          "Must match a subdirectory under skills-main/skills/ in the upstream tarball.",
      },
      scope: {
        type: "string",
        enum: ["team", "agent"],
        description:
          "'team' (default) installs to team/skills/ — shared with all agents. " +
          "'agent' installs to your own agent-local skills/ — private to you.",
      },
    },
    required: ["name"],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const name = String(args.name ?? "").trim();
    if (!name) return "Error: skill name is required";
    if (!SKILL_NAME_RE.test(name)) {
      return `Error: invalid skill name "${name}" — must match ${SKILL_NAME_RE.source} (single path segment, alphanum + . _ -)`;
    }

    const scope = args.scope === "agent" ? "agent" : "team";
    const targetSkillsDir =
      scope === "team"
        ? join(ctx.pathManager.team().root(), "skills")
        : join(ctx.pathManager.agent(ctx.agentId).root(), "skills");

    if (getSandboxFs().existsSync(join(targetSkillsDir, name, "SKILL.md"))) {
      return `Skill "${name}" already installed at ${scope} scope (${join(targetSkillsDir, name)}). No-op — call read_skill "${name}" to use it.`;
    }

    // Resolve upstream config: prefer user-configured value in overrides.json,
    // fallback to the lib defaults. Matches the pattern used by skill_bootstrap plugin.
    const raw = ctx.getAgentJson()?.capabilities?.config?.skills?.skill_bootstrap as
      | Record<string, unknown>
      | undefined;
    const upstream = typeof raw?.upstream === "string" ? raw.upstream : DEFAULT_UPSTREAM;
    const upstreamBasePath =
      typeof raw?.upstreamBasePath === "string" ? raw.upstreamBasePath : DEFAULT_UPSTREAM_BASE_PATH;

    const isAborted = () => ctx.signal.aborted;
    const results = await fetchSkillsToDir(
      ctx,
      [name],
      targetSkillsDir,
      upstream,
      upstreamBasePath,
      isAborted,
    );
    const result = results[0];
    if (!result) return `Error: fetch_skill produced no result for "${name}" (likely aborted)`;

    switch (result.status) {
      case "installed":
        return `Installed skill "${name}" at ${scope} scope → ${result.path}. Next turn the skills slot will include it; call read_skill "${name}" to read full instructions.`;
      case "skipped":
        return `Skill "${name}" already present at ${result.path}. No-op.`;
      case "not_in_upstream":
        return `Error: skill "${name}" not found in upstream (${upstream}). ${result.message ?? ""} — check the exact directory name at https://github.com/anthropics/skills/tree/main/skills`;
      case "download_failed":
        return `Error: could not download upstream tarball. ${result.message ?? ""}`;
      case "install_failed":
        return `Error: download succeeded but install failed. ${result.message ?? ""}`;
      default: {
        // Exhaustiveness guard: if FetchStatus gains a new variant,
        // TypeScript will flag this assignment at compile time.
        const _exhaustive: never = result.status;
        return `Error: unexpected fetch status "${String(_exhaustive)}" for skill "${name}"`;
      }
    }
  },

  formatDisplay(args, result) {
    const name = String(args.name ?? "");
    const scope = args.scope === "agent" ? "agent" : "team";
    const res = typeof result === "string" ? result : "";
    if (res.startsWith("Error")) return `fetch_skill ${name} — ${res}`;
    if (res.startsWith("Installed")) return `📦 fetched skill "${name}" → ${scope}`;
    if (res.includes("No-op")) return `fetch_skill "${name}" — already installed (${scope})`;
    return `fetch_skill "${name}" (${scope})`;
  },
} satisfies ToolDefinition;
