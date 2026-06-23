// @desc Add or remove an emoji reaction on a Discord message
import type { ToolDefinition, AgentContext } from "#src/core/types.js";
import { getDiscordClient } from "../../discord_setup/lib/discord-client.js";
import { loadConfig } from "../../discord_setup/lib/config.js";

export default {
  name: "react_message",
  condition: (ctx: AgentContext) => Boolean(loadConfig(ctx)?.finalized),
  description:
    "Add or remove an emoji reaction on a Discord message. " +
    "Use this to acknowledge messages, give feedback, or express sentiment.",
  input_schema: {
    type: "object" as const,
    properties: {
      message_id: {
        type: "string",
        description: "Discord message ID to react to",
      },
      channel_id: {
        type: "string",
        description: "Discord channel ID where the message is",
      },
      emoji: {
        type: "string",
        description: "Emoji to react with (Unicode emoji like ✅ 👍 ❌, or custom emoji name)",
      },
      action: {
        type: "string",
        enum: ["add", "remove"],
        description: "Whether to add or remove the reaction (default: add)",
      },
    },
    required: ["message_id", "channel_id", "emoji"],
  },

  async execute(args: Record<string, unknown>, ctx: AgentContext) {
    const client = getDiscordClient();
    if (!client?.isReady()) {
      return "Error: Discord bot is not connected. Check discord-status or reconnect.";
    }

    const messageId = String(args.message_id);
    const channelId = String(args.channel_id);
    const emoji = String(args.emoji);
    const action = (args.action as string) ?? "add";

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !("messages" in channel)) {
        return `Error: Channel ${channelId} is not a text channel or is inaccessible.`;
      }

      const message = await (channel as any).messages.fetch(messageId);
      if (!message) {
        return `Error: Message ${messageId} not found in channel ${channelId}.`;
      }

      if (action === "remove") {
        await message.reactions.cache.get(emoji)?.users.remove(client.user!.id);
        return `Removed reaction ${emoji} from message ${messageId}.`;
      }

      await message.react(emoji);
      return `Added reaction ${emoji} to message ${messageId}.`;
    } catch (e: any) {
      return `Failed to ${action} reaction: ${e.message}`;
    }
  },
  serial: false,
} satisfies ToolDefinition;
