import type { ToolDefinition } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { loadSkillByName } from "../lib/skills-loader.js";
import { SKILL_TEAMBOARD_KEY } from "../lib/skill-conditions.js";

export default {
  name: "read_skill",
  description:
    "Read the full content of a skill by name, including supporting file indexes. Use this after seeing the skills summary to get detailed instructions.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The skill name as shown in the Available Skills list",
      },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = String(args.name);
    const currentDir = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.CURRENT_DIR) as string | undefined;
    const skill = loadSkillByName(ctx.pathManager, ctx.agentId, name, currentDir);
    if (!skill) return `Skill "${name}" not found.`;

    const sections = [
      `# Skill: ${skill.name}`,
      "",
      `- Description: ${skill.description}`,
      `- File: ${skill.filePath}`,
    ];

    if (skill.license) sections.push(`- License: ${skill.license}`);
    if (skill.compatibility) sections.push(`- Compatibility: ${skill.compatibility}`);
    if (skill.metadata) sections.push(`- Metadata: ${JSON.stringify(skill.metadata)}`);
    if (skill.allowedTools?.length) sections.push(`- Allowed Tools: ${skill.allowedTools.join(", ")}`);

    sections.push("", "## Instructions", "", skill.content);
    if (skill.references.length > 0) {
      sections.push("", "## References", ...skill.references.map((entry) => `- ${entry}`));
    }
    if (skill.scripts.length > 0) {
      sections.push("", "## Scripts", ...skill.scripts.map((entry) => `- ${entry}`));
    }
    if (skill.assets.length > 0) {
      sections.push("", "## Assets", ...skill.assets.map((entry) => `- ${entry}`));
    }

    if (
      skill.references.length > 0 ||
      skill.scripts.length > 0 ||
      skill.assets.length > 0
    ) {
      sections.push(
        "",
        "Use the standard read_file tool to inspect any listed supporting file, and use shell/exec tools directly when the skill asks you to run a script.",
      );
    }

    ctx.teamBoard.set(ctx.agentId, SKILL_TEAMBOARD_KEY, {
      name: skill.name,
      allowed_tools: skill.allowedTools ?? [],
    });

    return sections.join("\n");
  },
} satisfies ToolDefinition;
