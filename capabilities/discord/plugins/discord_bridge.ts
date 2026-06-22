// @desc Discord bridge plugin — bot connection, multi-source inbox, reconnect, guild events
import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext, SelfEvent } from "#src/core/types.js";
import {
  loadConfig, saveConfig, discordInboxDir, discordGuildsDir,
} from "../../discord_setup/lib/config.js";
import {
  acquireClient, releaseClient, getDiscordClient,
} from "../../discord_setup/lib/discord-client.js";
import { classifyMessage } from "../../discord_setup/lib/mention-gate.js";
import { extractInboundText, buildDiscordMeta } from "../../discord_setup/lib/message-formatter.js";
import { appendToSource, countUnread, readRecentByChannel } from "../../discord_setup/lib/inbox.js";
import { writeGuildSnapshot } from "../../discord_setup/lib/guild-snapshot.js";
import type { Message, MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";

// ── Message dedup ──

const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX = 1000;
const recentIds = new Map<string, number>();

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  if (recentIds.has(messageId)) return true;
  recentIds.set(messageId, now);
  if (recentIds.size > DEDUP_MAX) {
    for (const [id, ts] of recentIds) {
      if (now - ts > DEDUP_TTL_MS) recentIds.delete(id);
    }
  }
  return false;
}

// ── Reconnection constants ──

const HEALTH_CHECK_MS = 30_000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 20;

export default function create(ctx: AgentContext): PluginSource {
  let reminderTimer: ReturnType<typeof setInterval> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnecting = false;


  function emitToAgent(event: SelfEvent): void {
    if (stopped) return;
    ctx.eventBus.emitToSelf(event);
  }

  async function handleMessageCreate(msg: Message): Promise<void> {
    const client = getDiscordClient();
    if (!client?.user) return;
    if (msg.author.id === client.user.id) return;
    if (msg.author.bot) return;
    if (isDuplicate(msg.id)) return;

    const cfg = loadConfig(ctx);
    if (!cfg) return;

    const isDM = msg.channel.isDMBased();
    const isMentioned = msg.mentions.has(client.user);
    const isReplyToBot = Boolean(
      msg.reference?.messageId &&
      msg.mentions.repliedUser?.id === client.user.id,
    );

    const classification = classifyMessage({
      isDM,
      isMentioned,
      isReplyToBot,
      requireMention: cfg.behavior.requireMention,
    });

    const inboxBase = discordInboxDir(ctx);
    const meta = buildDiscordMeta(msg, client.user.id);

    // ── Step 1: ALL messages → inbox history (DM + guild) ──
    const inboxEntry = {
      ts: Date.now(),
      direction: "in" as const,
      source: (isDM ? "dm" : "guild") as "dm" | "guild",
      guildId: msg.guildId ?? undefined,
      guildName: msg.guild?.name ?? "",
      channelName: "name" in msg.channel ? (msg.channel.name ?? msg.channelId) : msg.channelId,
      channelId: msg.channelId,
      author: msg.author.tag ?? msg.author.username,
      authorId: msg.author.id,
      messageId: msg.id,
      content: extractInboundText(msg),
      hasAttachment: msg.attachments.size > 0,
    };
    appendToSource(inboxBase, inboxEntry);

    // ── Step 2: Classification-based handling ──

    if (classification === "inbox") {
      // Silent inbox — already stored above, nothing more to do
      return;
    }

    const text = extractInboundText(msg, client.user.id);

    if (classification === "inbox_notify") {
      // Guild @mention / reply → read context + emit discord_mention event
      const contextMessages = readRecentByChannel(
        inboxBase, msg.guildId ?? "unknown", msg.channelId, 10,
      );
      const contextFormatted = contextMessages.map(e =>
        `[${new Date(e.ts).toLocaleTimeString()}] ${e.author}: ${e.content}`,
      ).join("\n");

      emitToAgent({
        source: "plugin:discord_bridge",
        type: "discord_mention",
        payload: {
          content: `[Discord @mention in ${meta.guildName}/#${meta.channelName}]\n` +
            `From: ${meta.authorTag}\n` +
            `Message: ${text}\n\n` +
            (contextFormatted ? `Recent context (${contextMessages.length} messages):\n${contextFormatted}` : ""),
          discord: meta,
          contextMessages,
        },
        ts: Date.now(),
        handoff: "turn",
      });
      return;
    }

    // ── "respond" — DM direct trigger ──

    emitToAgent({
      source: "plugin:discord_bridge",
      type: "user_input",
      payload: {
        content: text,
        discord: meta,
      },
      ts: Date.now(),
      handoff: "turn",
    });
  }

  async function handleReactionAdd(
    rawReaction: MessageReaction | PartialMessageReaction,
    rawUser: User | PartialUser,
  ): Promise<void> {
    let reaction: MessageReaction;
    let user: User;
    try {
      reaction = rawReaction.partial ? await rawReaction.fetch() : rawReaction;
      user = rawUser.partial ? await rawUser.fetch() : rawUser as User;
    } catch { return; }

    const client = getDiscordClient();
    if (!client?.user) return;
    if (user.id === client.user.id) return;
    if (user.bot) return;

    const cfg = loadConfig(ctx);
    if (!cfg) return;

    if (cfg.behavior.reactionNotifyMode === "off") return;
    if (cfg.behavior.reactionNotifyMode === "own") {
      if (reaction.message.author?.id !== client.user.id) return;
    }

    const emoji = reaction.emoji.name ?? reaction.emoji.toString();
    const channelName = "name" in reaction.message.channel
      ? (reaction.message.channel.name ?? reaction.message.channelId)
      : reaction.message.channelId;
    const userLabel = user.tag ?? user.username;

    emitToAgent({
      source: "plugin:discord_bridge",
      type: "discord_reaction",
      payload: {
        content: `[Discord Reaction] ${userLabel} reacted with ${emoji} on your message in ${channelName}`,
        emoji,
        messageId: reaction.message.id,
        channelId: reaction.message.channelId,
        userId: user.id,
        userTag: userLabel,
        action: "add",
      },
      ts: Date.now(),
      handoff: "passive",
    });
  }

  async function handleReactionRemove(
    rawReaction: MessageReaction | PartialMessageReaction,
    rawUser: User | PartialUser,
  ): Promise<void> {
    let reaction: MessageReaction;
    let user: User;
    try {
      reaction = rawReaction.partial ? await rawReaction.fetch() : rawReaction;
      user = rawUser.partial ? await rawUser.fetch() : rawUser as User;
    } catch { return; }

    const client = getDiscordClient();
    if (!client?.user) return;
    if (user.id === client.user.id) return;

    const cfg = loadConfig(ctx);
    if (!cfg || cfg.behavior.reactionNotifyMode !== "all") return;

    const emoji = reaction.emoji.name ?? reaction.emoji.toString();
    const userLabel = user.tag ?? user.username;

    emitToAgent({
      source: "plugin:discord_bridge",
      type: "discord_reaction",
      payload: {
        content: `[Discord Reaction Removed] ${userLabel} removed ${emoji} from message in channel ${reaction.message.channelId}`,
        emoji,
        messageId: reaction.message.id,
        channelId: reaction.message.channelId,
        userId: user.id,
        action: "remove",
      },
      ts: Date.now(),
      handoff: "passive",
    });
  }

  function setupInboxReminder(): void {
    const cfg = loadConfig(ctx);
    const interval = cfg?.behavior.inboxReminderIntervalMs ?? 30 * 60 * 1000;

    reminderTimer = setInterval(() => {
      if (stopped) return;
      const inboxBase = discordInboxDir(ctx);
      const counts = countUnread(inboxBase);
      if (counts.guild > 0) {
        emitToAgent({
          source: "plugin:discord_bridge",
          type: "inbox_reminder",
          payload: {
            content: `[Discord Inbox] You have ${counts.guild} unread guild message(s). Use check_discord_inbox to review.`,
          },
          ts: Date.now(),
          priority: 2,
          handoff: "passive",
        });
      }
    }, interval);
  }

  return {
    name: "discord_bridge",

    start() {
      stopped = false;
      reconnectAttempts = 0;
      reconnecting = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      const cfg = loadConfig(ctx);
      if (!cfg?.token) {
        console.log("[discord_bridge] No Discord config found, skipping start");
        return;
      }

      connectAndSetup(cfg.token);
    },

    stop() {
      stopped = true;

      if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }

      releaseClient().catch(() => {});
    },
  };

  function connectAndSetup(token: string): void {
    acquireClient(token)
      .then(async (client) => {
        if (stopped) {
          await releaseClient();
          return;
        }

        console.log(`[discord_bridge] Connected as ${client.user?.tag}`);
        reconnectAttempts = 0;
        reconnecting = false;

        setupClientHandlers(client);
        setupHealthCheck(token);
        setupInboxReminder();

        // Write guild snapshots on connect
        const guildsDir = discordGuildsDir(ctx);
        for (const [, guild] of client.guilds.cache) {
          writeGuildSnapshot(guildsDir, guild).catch(() => {});
        }

      })
      .catch((err) => {
        console.error("[discord_bridge] Failed to connect:", err);
        if (!stopped) attemptReconnect(token);
      });
  }

  function setupClientHandlers(client: ReturnType<typeof getDiscordClient> & {}): void {
    client.on("messageCreate", (msg) => {
            handleMessageCreate(msg).catch((err) =>
              console.error("[discord_bridge] messageCreate error:", err),
            );
          });

          client.on("messageReactionAdd", (reaction, user) => {
            handleReactionAdd(reaction, user).catch((err) =>
              console.error("[discord_bridge] reactionAdd error:", err),
            );
          });

          client.on("messageReactionRemove", (reaction, user) => {
            handleReactionRemove(reaction, user).catch((err) =>
              console.error("[discord_bridge] reactionRemove error:", err),
            );
          });

          // Guild join/leave events
          client.on("guildCreate", (guild) => {
            const currentCfg = loadConfig(ctx);
            if (currentCfg) {
              const exists = currentCfg.guilds.some(g => g.id === guild.id);
              if (!exists) {
                currentCfg.guilds.push({
                  id: guild.id,
                  name: guild.name,
                  joinedAt: new Date().toISOString(),
                });
                saveConfig(ctx, currentCfg);
              }
            }
            writeGuildSnapshot(discordGuildsDir(ctx), guild).catch(() => {});
            emitToAgent({
              source: "plugin:discord_bridge",
              type: "discord_guild_joined",
              payload: {
                content: `[Discord] Bot was added to guild "${guild.name}" (${guild.id}), ${guild.memberCount} members.`,
              },
              ts: Date.now(),
              handoff: "passive",
            });
          });

          client.on("guildDelete", (guild) => {
            const currentCfg = loadConfig(ctx);
            if (currentCfg) {
              currentCfg.guilds = currentCfg.guilds.filter(g => g.id !== guild.id);
              saveConfig(ctx, currentCfg);
            }
            emitToAgent({
              source: "plugin:discord_bridge",
              type: "discord_guild_left",
              payload: {
                content: `[Discord] Bot was removed from guild "${guild.name ?? guild.id}" (${guild.id}).`,
              },
              ts: Date.now(),
              handoff: "passive",
            });
          });

  }

  function setupHealthCheck(token: string): void {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (stopped) return;
      const client = getDiscordClient();
      if (!client || !client.isReady()) {
        console.warn("[discord_bridge] Health check: client not ready, attempting reconnect");
        attemptReconnect(token);
      }
    }, HEALTH_CHECK_MS);
  }

  function attemptReconnect(token: string): void {
    if (stopped || reconnecting) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[discord_bridge] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
      emitToAgent({
        source: "plugin:discord_bridge",
        type: "discord_connection_lost",
        payload: { content: "[Discord] 连接永久丢失，已达到最大重连次数。请检查网络或 bot token。" },
        ts: Date.now(),
        handoff: "turn",
      });
      return;
    }

    reconnecting = true;
    reconnectAttempts++;
    const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts - 1), MAX_BACKOFF_MS);
    console.log(`[discord_bridge] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${backoff}ms`);

    emitToAgent({
      source: "plugin:discord_bridge",
      type: "discord_disconnected",
      payload: { content: `[Discord] Bot连接已断开，正在尝试重连... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})` },
      ts: Date.now(),
      handoff: "silent",
    });

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (stopped) { reconnecting = false; return; }
      try {
        await releaseClient();
      } catch { /* ignore */ }
      reconnecting = false;
      connectAndSetup(token);
    }, backoff);
  }
}
