// @desc Check Discord multi-source inbox — read/filter unread messages by DM or guild
import type { ToolDefinition, AgentContext } from "#src/core/types.js";
import { discordInboxDir, loadConfig } from "../../discord_setup/lib/config.js";
import { readUnread, markRead, countUnread } from "../../discord_setup/lib/inbox.js";
import type { InboxEntry } from "../../discord_setup/lib/inbox.js";

export default {
  name: "check_discord_inbox",
  condition: (ctx: AgentContext) => Boolean(loadConfig(ctx)?.finalized),
  description:
    "Review unread guild messages from your inbox. " +
    "Guild messages where you were not @mentioned are collected here. " +
    "Filter by specific guild if needed.",
  input_schema: {
    type: "object" as const,
    properties: {
      guild: {
        type: "string",
        description: "Filter by guild ID (only when source=guild or source=all)",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages to return (default: 50)",
      },
      channel: {
        type: "string",
        description: "Filter by channel name (optional)",
      },
      mark_read: {
        type: "boolean",
        description: "Mark returned messages as read (default: true)",
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx: AgentContext) {
    const inboxBase = discordInboxDir(ctx);
    const limit = (typeof args.limit === "number" && args.limit > 0) ? args.limit : 50;
    const channelFilter = typeof args.channel === "string" ? args.channel : undefined;
    const shouldMarkRead = args.mark_read !== false;
    const source = (args.source === "dm" || args.source === "guild") ? args.source : "all" as const;
    const guildId = typeof args.guild === "string" ? args.guild : undefined;

    const counts = countUnread(inboxBase);
    const entries = readUnread(inboxBase, {
      source,
      guildId,
      limit,
      channelFilter,
    });

    if (entries.length === 0) {
      return counts.total === 0
        ? "Discord inbox is empty — no unread messages."
        : `No messages match the filter. Total unread: ${counts.dm} DM + ${counts.guild} guild = ${counts.total}`;
    }

    // Group by source category
    const dmEntries: InboxEntry[] = [];
    const guildGroups = new Map<string, InboxEntry[]>();

    for (const e of entries) {
      if (e.source === "dm") {
        dmEntries.push(e);
      } else {
        const key = e.guildId ?? "unknown";
        if (!guildGroups.has(key)) guildGroups.set(key, []);
        guildGroups.get(key)!.push(e);
      }
    }

    const lines: string[] = [];
    lines.push(`Discord Inbox: ${entries.length} message(s) (${counts.dm} DM, ${counts.guild} guild total unread)`);
    lines.push("");

    // DM section
    if (dmEntries.length > 0) {
      const byAuthor = new Map<string, InboxEntry[]>();
      for (const e of dmEntries) {
        const key = e.author;
        if (!byAuthor.has(key)) byAuthor.set(key, []);
        byAuthor.get(key)!.push(e);
      }
      for (const [author, msgs] of byAuthor) {
        lines.push(`── DM: ${author} ──`);
        for (const m of msgs) {
          const time = new Date(m.ts).toISOString().slice(11, 16);
          const attach = m.hasAttachment ? " [+attachment]" : "";
          lines.push(`  [${time}] ${m.author}: ${m.content}${attach}`);
          lines.push(`           (messageId: ${m.messageId})`);
        }
        lines.push("");
      }
    }

    // Guild section
    for (const [, guildMsgs] of guildGroups) {
      const byChannel = new Map<string, InboxEntry[]>();
      for (const e of guildMsgs) {
        const key = `${e.guildName} / #${e.channelName}`;
        if (!byChannel.has(key)) byChannel.set(key, []);
        byChannel.get(key)!.push(e);
      }
      for (const [channel, msgs] of byChannel) {
        lines.push(`── ${channel} ──`);
        for (const m of msgs) {
          const time = new Date(m.ts).toISOString().slice(11, 16);
          const attach = m.hasAttachment ? " [+attachment]" : "";
          lines.push(`  [${time}] ${m.author}: ${m.content}${attach}`);
          lines.push(`           (messageId: ${m.messageId})`);
        }
        lines.push("");
      }
    }

    if (shouldMarkRead && entries.length > 0) {
      const latestTs = Math.max(...entries.map(e => e.ts));
      markRead(inboxBase, { source, guildId, upToTs: latestTs });
      lines.push(`Marked ${entries.length} message(s) as read.`);
    }

    return lines.join("\n");
  },

  compactResult(args) {
    const parts = [`check_discord_inbox`];
    if (args.source && args.source !== "all") parts.push(`source="${args.source}"`);
    if (args.guild) parts.push(`guild="${args.guild}"`);
    if (args.channel) parts.push(`channel="${args.channel}"`);
    return `[${parts.join(" ")}]`;
  },
} satisfies ToolDefinition;
