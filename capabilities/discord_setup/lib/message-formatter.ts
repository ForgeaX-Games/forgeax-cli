// @desc Discord message formatting — inbound/outbound text conversion
import type { Message } from "discord.js";

/**
 * Extract clean text from a Discord message, stripping bot mention prefix.
 */
export function extractInboundText(msg: Message, botId?: string): string {
  let text = msg.content ?? "";

  if (botId) {
    text = text.replace(new RegExp(`^<@!?${botId}>\\s*`), "").trim();
  }

  if (msg.attachments.size > 0) {
    const attachmentDescs = msg.attachments.map(a => {
      const type = a.contentType?.startsWith("image/") ? "image"
        : a.contentType?.startsWith("audio/") ? "audio"
        : a.contentType?.startsWith("video/") ? "video"
        : "file";
      return `[${type}: ${a.name ?? a.url}]`;
    });
    if (text) text += "\n";
    text += attachmentDescs.join("\n");
  }

  return text;
}

/**
 * Build Discord metadata payload for an inbound message event.
 */
export function buildDiscordMeta(msg: Message, botId?: string) {
  const isDM = msg.channel.isDMBased();
  return {
    messageId: msg.id,
    channelId: msg.channelId,
    channelName: isDM ? "DM" : ("name" in msg.channel ? (msg.channel.name ?? msg.channelId) : msg.channelId),
    guildId: msg.guildId ?? null,
    guildName: msg.guild?.name ?? null,
    isDM,
    authorId: msg.author.id,
    authorTag: msg.author.tag ?? msg.author.username,
    replyToMessageId: msg.reference?.messageId ?? null,
  };
}

/**
 * Truncate outbound text to Discord's 2000-char limit, splitting into chunks.
 */
export function chunkText(text: string, maxLen = 2000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}
