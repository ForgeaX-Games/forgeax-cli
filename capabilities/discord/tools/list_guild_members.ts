// @desc List members of a Discord guild via REST — id, username, displayName, bot flag
import type { ToolDefinition, AgentContext } from "#src/core/types.js";
import { Routes } from "discord.js";
import { getDiscordClient } from "../../discord_setup/lib/discord-client.js";
import { loadConfig } from "../../discord_setup/lib/config.js";

interface RawMember {
  user?: {
    id: string;
    username: string;
    bot?: boolean;
  };
  nick?: string | null;
}

export default {
  name: "list_guild_members",
  condition: (ctx: AgentContext) => Boolean(loadConfig(ctx)?.finalized),
  description:
    "List members of a Discord guild via REST — returns id, username, display name (server nickname or username), " +
    "and bot flag for each member. Useful for finding the @mention ID of a user/bot before sending a message. " +
    "Requires the Server Members privileged intent enabled in the Discord dev portal " +
    "(no Gateway intent change required — uses REST endpoint, login unaffected).",
  input_schema: {
    type: "object" as const,
    properties: {
      guild_id: {
        type: "string",
        description: "Discord guild (server) ID to list members from",
      },
      include_bots: {
        type: "boolean",
        description: "Include bot accounts in the result (default: true)",
      },
      limit: {
        type: "number",
        description: "Maximum number of members to fetch and return (default: 100, capped at 1000 per Discord REST limit)",
      },
    },
    required: ["guild_id"],
  },

  async execute(args: Record<string, unknown>) {
    const client = getDiscordClient();
    if (!client?.isReady()) {
      return "Error: Discord bot is not connected. Check discord-status or reconnect.";
    }

    const guildId = String(args.guild_id);
    const includeBots = args.include_bots !== false;
    const reqLimit = (typeof args.limit === "number" && args.limit > 0) ? args.limit : 100;
    const fetchLimit = Math.min(reqLimit, 1000);

    try {
      const raw = await client.rest.get(
        Routes.guildMembers(guildId),
        { query: new URLSearchParams({ limit: String(fetchLimit) }) },
      ) as RawMember[];

      const totalFetched = raw.length;
      const filtered = raw.filter(m => includeBots || !m.user?.bot);

      if (filtered.length === 0) {
        return `Guild ${guildId}: no members match filter (fetched ${totalFetched}, after filter 0).`;
      }

      const lines = filtered.map(m => {
        const u = m.user;
        if (!u) return "  <unknown> — id: ?";
        const tag = u.bot ? " [BOT]" : "";
        const nick = m.nick && m.nick !== u.username
          ? ` (nickname: ${m.nick})`
          : "";
        return `  ${u.username}${tag} — id: ${u.id}${nick}`;
      });

      const truncatedNote = totalFetched === fetchLimit
        ? ` (fetched up to limit ${fetchLimit}, more may exist; raise limit to see)`
        : "";

      return `Guild ${guildId} — ${filtered.length} member(s) shown${truncatedNote}:\n${lines.join("\n")}`;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Missing Access") || msg.includes("disallowed intents") || msg.includes("403")) {
        return `Error: REST returned forbidden — the bot's app needs the "Server Members" privileged intent enabled in the Discord dev portal (https://discord.com/developers/applications → your app → Bot → toggle "Server Members Intent"). After enabling, this tool works immediately (no restart needed since it uses REST, not Gateway). (raw: ${msg})`;
      }
      if (msg.includes("Unknown Guild") || msg.includes("404")) {
        return `Error: Guild ${guildId} not found, or the bot is not a member of this guild. (raw: ${msg})`;
      }
      return `Error: Failed to fetch guild members: ${msg}`;
    }
  },
  serial: false,
} satisfies ToolDefinition;
