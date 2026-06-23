// @desc Send text or media to a Discord channel, with optional reply reference
import { join, extname } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ToolDefinition, AgentContext } from "#src/core/types.js";
import { getDiscordClient } from "../../discord_setup/lib/discord-client.js";
import { discordInboxDir, loadConfig } from "../../discord_setup/lib/config.js";
import { appendToSource } from "../../discord_setup/lib/inbox.js";
import { chunkText } from "../../discord_setup/lib/message-formatter.js";

export default {
  name: "reply_discord",
  condition: (ctx: AgentContext) => Boolean(loadConfig(ctx)?.finalized),
  description:
    "Send a message to a Discord channel. Supports text, file attachments, or both. " +
    "Optionally reply to a specific message with a native reference.",
  input_schema: {
    type: "object" as const,
    properties: {
      channel_id: {
        type: "string",
        description: "Discord channel ID to send the message in",
      },
      content: {
        type: "string",
        description: "Text content to send (optional if file_path is provided)",
      },
      reply_to: {
        type: "string",
        description: "Message ID to reply to (creates a native Discord reply reference). Optional.",
      },
      file_path: {
        type: "string",
        description: "Absolute path to a local file to attach (image, document, etc.). Optional.",
      },
      file_name: {
        type: "string",
        description: "Display name for the attached file (e.g. 'screenshot.png'). Defaults to the original filename.",
      },
    },
    required: ["channel_id"],
  },

  async execute(args: Record<string, unknown>, ctx: AgentContext) {
    const client = getDiscordClient();
    if (!client?.isReady()) {
      return "Error: Discord bot is not connected. Check discord-status or reconnect.";
    }

    const channelId = String(args.channel_id);
    const content = typeof args.content === "string" ? args.content : "";
    const replyTo = args.reply_to ? String(args.reply_to) : undefined;
    const filePath = typeof args.file_path === "string" ? args.file_path : undefined;
    const fileName = typeof args.file_name === "string" ? args.file_name : undefined;

    if (!content && !filePath) {
      return "Error: At least one of content or file_path must be provided.";
    }

    if (filePath) {
      const fileExists = await ctx.fs.exists(filePath);
      if (!fileExists) return `Error: File not found: ${filePath}`;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !("send" in channel)) {
        return `Error: Channel ${channelId} is not a text channel or is inaccessible.`;
      }

      const inboxBase = discordInboxDir(ctx);
      const isDM = channel.isDMBased();
      const chName = "name" in channel ? (channel.name ?? channelId) : channelId;
      const botTag = client.user?.tag ?? "bot";
      const botId = client.user?.id ?? "";
      const sentIds: string[] = [];

      // Stage container files to host for Discord.js
      let attachPath = filePath;
      if (filePath && ctx.fs.needsProxy(filePath)) {
        const buf = await ctx.fs.readBinary(filePath);
        const stagingDir = join(tmpdir(), "agenteam-discord-staging");
        getSandboxFs().mkdirSync(stagingDir);
        attachPath = join(stagingDir, `${randomUUID()}${extname(filePath)}`);
        getSandboxFs().writeBinarySync(attachPath, buf);
      }

      if (filePath) {
        const opts: Record<string, unknown> = {
          files: [{ attachment: attachPath!, ...(fileName ? { name: fileName } : {}) }],
        };
        if (content) opts.content = content;
        if (replyTo) {
          opts.reply = { messageReference: replyTo, failIfNotExists: false };
        }

        const sent = await (channel as any).send(opts);
        sentIds.push(sent.id);

        appendToSource(inboxBase, {
          ts: Date.now(),
          direction: "out",
          source: isDM ? "dm" : "guild",
          guildId: "guildId" in channel && channel.guildId ? channel.guildId : undefined,
          guildName: "",
          channelName: chName,
          channelId,
          author: botTag,
          authorId: botId,
          messageId: sent.id,
          content: content || `[file: ${fileName ?? filePath}]`,
          hasAttachment: true,
        });
      } else {
        const chunks = chunkText(content);
        for (let i = 0; i < chunks.length; i++) {
          const opts: Record<string, unknown> = { content: chunks[i] };
          if (i === 0 && replyTo) {
            opts.reply = { messageReference: replyTo, failIfNotExists: false };
          }
          const sent = await (channel as any).send(opts);
          sentIds.push(sent.id);

          appendToSource(inboxBase, {
            ts: Date.now(),
            direction: "out",
            source: isDM ? "dm" : "guild",
            guildId: "guildId" in channel && channel.guildId ? channel.guildId : undefined,
            guildName: "",
            channelName: chName,
            channelId,
            author: botTag,
            authorId: botId,
            messageId: sent.id,
            content: chunks[i],
            hasAttachment: false,
          });
        }
      }

      const parts: string[] = [`Message sent to channel ${channelId}`];
      if (replyTo) parts.push(`(replying to ${replyTo})`);
      if (filePath) parts.push(`[attached: ${fileName ?? filePath.split("/").pop()}]`);
      parts.push(`Message ID(s): ${sentIds.join(", ")}`);
      return parts.join(". ");
    } catch (e: any) {
      return `Failed to send message: ${e.message}`;
    }
  },
} satisfies ToolDefinition;
