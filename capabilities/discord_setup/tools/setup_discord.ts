// @desc Interactive Discord bot setup wizard with reset support
import type { ToolDefinition, AgentContext } from "#src/core/types.js";
import {
  loadConfig, saveConfig, resetConfig, createPartialConfig,
  discordGuildsDir,
} from "../lib/config.js";
import { validateToken, fetchBotGuilds, destroyDiscordClient } from "../lib/discord-client.js";

const REQUIRED_PERMISSIONS = [
  "Send Messages",
  "Add Reactions",
  "Read Message History",
  "View Channels",
  "Embed Links",
  "Attach Files",
  "Use External Emojis",
];
const PERMISSIONS_INT = 277025770560;

type Action = "status" | "set_token" | "generate_invite" | "verify" | "configure" | "finalize" | "reset";

export default {
  name: "setup_discord",
  description:
    "Interactive Discord bot setup wizard. Use step by step: " +
    "status → set_token → generate_invite → verify → configure → finalize. " +
    "Use reset to remove current config and start over (preserves inbox history).",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "set_token", "generate_invite", "verify", "configure", "finalize", "reset"],
        description: "Setup step to execute",
      },
      token: {
        type: "string",
        description: "Discord bot token (only for set_token action)",
      },
      config: {
        type: "object",
        description: "Behavior configuration (only for configure action)",
        properties: {
          requireMention: { type: "boolean", description: "Require @mention in guild channels (default: true)" },
          inboxReminderIntervalMs: { type: "number", description: "Inbox reminder interval in ms (default: 1800000)" },
          reactionNotifyMode: { type: "string", enum: ["off", "own", "all"], description: "Reaction notification mode (default: own)" },
        },
      },
    },
    required: ["action"],
  },

  async execute(args: Record<string, unknown>, ctx: AgentContext) {
    const action = args.action as Action;

    switch (action) {
      case "status":
        return handleStatus(ctx);
      case "set_token":
        return handleSetToken(ctx, args.token as string | undefined);
      case "generate_invite":
        return handleGenerateInvite(ctx);
      case "verify":
        return handleVerify(ctx);
      case "configure":
        return handleConfigure(ctx, args.config as Record<string, unknown> | undefined);
      case "finalize":
        return handleFinalize(ctx);
      case "reset":
        return handleReset(ctx);
      default:
        return `Unknown action: ${action}. Valid actions: status, set_token, generate_invite, verify, configure, finalize, reset`;
    }
  },
} satisfies ToolDefinition;

// ── Action handlers ──

function handleStatus(ctx: AgentContext): string {
  const cfg = loadConfig(ctx);
  if (!cfg) {
    return [
      "Discord Status: NOT CONFIGURED",
      "",
      "To set up Discord, follow these steps:",
      "1. Ask the user for their Discord bot token",
      "2. Call setup_discord(action: 'set_token', token: '<token>')",
      "",
      "If the user doesn't have a bot yet, share these instructions:",
      "",
      "=== How to Create a Discord Bot ===",
      "1. Go to https://discord.com/developers/applications",
      "2. Click 'New Application', enter a name, and create",
      "3. In the left menu, click 'Bot'",
      "4. Click 'Reset Token' and copy the token",
      "5. IMPORTANT: Under 'Privileged Gateway Intents', enable MESSAGE CONTENT INTENT",
      "6. Share the token with the agent",
      "================================",
    ].join("\n");
  }

  const parts = [`Discord Status: ${cfg.finalized ? "CONFIGURED" : "PARTIALLY CONFIGURED"}`];
  parts.push(`Bot: ${cfg.botUsername} (ID: ${cfg.botId})`);
  parts.push(`Application ID: ${cfg.applicationId}`);
  parts.push(`Guilds: ${cfg.guilds.length > 0 ? cfg.guilds.map(g => `${g.name} (${g.id})`).join(", ") : "none"}`);
  parts.push(`Finalized: ${cfg.finalized}`);

  if (cfg.finalized) {
    parts.push("");
    parts.push("Behavior settings:");
    parts.push(`  requireMention: ${cfg.behavior.requireMention}`);
    parts.push(`  inboxReminderInterval: ${cfg.behavior.inboxReminderIntervalMs}ms`);
    parts.push(`  reactionNotifyMode: ${cfg.behavior.reactionNotifyMode}`);
    parts.push("");
    parts.push("Use setup_discord(action: 'reset') to remove this configuration and start over.");
  } else {
    parts.push("");
    parts.push("Setup is incomplete. Continue with the next step.");
  }

  return parts.join("\n");
}

async function handleSetToken(ctx: AgentContext, token?: string): Promise<string> {
  if (!token) {
    return [
      "Error: No token provided.",
      "",
      "Usage: setup_discord(action: 'set_token', token: '<bot_token>')",
      "",
      "Tell the user to get a bot token by following these steps:",
      "",
      "=== How to Get a Discord Bot Token ===",
      "1. Go to https://discord.com/developers/applications",
      "2. Click 'New Application' → enter a name → Create",
      "3. Left menu → 'Bot'",
      "4. Click 'Reset Token' → Copy the token",
      "5. IMPORTANT: Scroll down to 'Privileged Gateway Intents'",
      "   → Enable 'MESSAGE CONTENT INTENT' (required for reading messages)",
      "6. Give the token to the agent",
      "======================================",
    ].join("\n");
  }

  try {
    const info = await validateToken(token.trim());
    const cfg = createPartialConfig(token.trim(), info.applicationId, info.id, info.tag);
    saveConfig(ctx, cfg);

    return [
      "Token validated successfully!",
      "",
      `Bot: ${info.tag}`,
      `Bot ID: ${info.id}`,
      `Application ID: ${info.applicationId}`,
      "",
      "Next step: Call setup_discord(action: 'generate_invite') to create an invite link.",
    ].join("\n");
  } catch (e: any) {
    return `Token validation failed: ${e.message}\n\nPlease check the token and try again.`;
  }
}

function handleGenerateInvite(ctx: AgentContext): string {
  const cfg = loadConfig(ctx);
  if (!cfg) {
    return "Error: No token configured. Run setup_discord(action: 'set_token') first.";
  }

  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${cfg.applicationId}&permissions=${PERMISSIONS_INT}&scope=bot`;

  return [
    "Bot invite link generated!",
    "",
    "Share this link with the user and ask them to:",
    "",
    "=== How to Add the Bot to a Server ===",
    `1. Click this link: ${inviteUrl}`,
    "2. Select the target Discord server from the dropdown",
    "3. Review and confirm the permissions",
    "4. Click 'Authorize'",
    "5. Tell the agent when it's done",
    "======================================",
    "",
    `Required permissions: ${REQUIRED_PERMISSIONS.join(", ")}`,
    "",
    "After the user adds the bot, call setup_discord(action: 'verify') to confirm.",
  ].join("\n");
}

async function handleVerify(ctx: AgentContext): Promise<string> {
  const cfg = loadConfig(ctx);
  if (!cfg) {
    return "Error: No token configured. Run setup_discord(action: 'set_token') first.";
  }

  try {
    const guilds = await fetchBotGuilds(cfg.token);

    if (guilds.length === 0) {
      return [
        "The bot is not in any servers yet.",
        "",
        "Ask the user to add the bot using the invite link from setup_discord(action: 'generate_invite').",
      ].join("\n");
    }

    cfg.guilds = guilds.map(g => ({
      id: g.id,
      name: g.name,
      joinedAt: new Date().toISOString(),
    }));
    saveConfig(ctx, cfg);

    const guildList = guilds.map(g => `  - ${g.name} (ID: ${g.id})`).join("\n");

    return [
      `Bot is in ${guilds.length} server(s):`,
      guildList,
      "",
      "Guild information saved.",
      "",
      "Next step: Call setup_discord(action: 'configure') to set behavior options,",
      "or call setup_discord(action: 'finalize') to use defaults and activate.",
    ].join("\n");
  } catch (e: any) {
    return `Failed to verify: ${e.message}`;
  }
}

function handleConfigure(ctx: AgentContext, config?: Record<string, unknown>): string {
  const cfg = loadConfig(ctx);
  if (!cfg) {
    return "Error: No token configured. Run setup_discord(action: 'set_token') first.";
  }

  if (config) {
    if (typeof config.requireMention === "boolean") {
      cfg.behavior.requireMention = config.requireMention;
    }
    if (typeof config.inboxReminderIntervalMs === "number" && config.inboxReminderIntervalMs > 0) {
      cfg.behavior.inboxReminderIntervalMs = config.inboxReminderIntervalMs;
    }
    if (config.reactionNotifyMode === "off" || config.reactionNotifyMode === "own" || config.reactionNotifyMode === "all") {
      cfg.behavior.reactionNotifyMode = config.reactionNotifyMode;
    }
    saveConfig(ctx, cfg);
  }

  return [
    "Current behavior configuration:",
    `  requireMention: ${cfg.behavior.requireMention}`,
    `    → When true, only messages that @mention the bot trigger a response.`,
    `    → Non-mentioned guild messages go to inbox for later review.`,
    "",
    `  inboxReminderIntervalMs: ${cfg.behavior.inboxReminderIntervalMs} (${Math.round(cfg.behavior.inboxReminderIntervalMs / 60000)} minutes)`,
    `    → How often the agent is reminded about unread inbox messages.`,
    "",
    `  reactionNotifyMode: ${cfg.behavior.reactionNotifyMode}`,
    `    → off: ignore all reactions`,
    `    → own: notify when someone reacts to the bot's messages`,
    `    → all: notify on all reactions the bot can see`,
    "",
    "To change, call setup_discord(action: 'configure', config: { ... }).",
    "When ready, call setup_discord(action: 'finalize') to activate.",
  ].join("\n");
}

function handleFinalize(ctx: AgentContext): string {
  const cfg = loadConfig(ctx);
  if (!cfg) {
    return "Error: No token configured. Run setup_discord(action: 'set_token') first.";
  }

  cfg.finalized = true;
  saveConfig(ctx, cfg);

  return [
    "Discord setup complete! Configuration finalized.",
    "",
    `Bot: ${cfg.botUsername}`,
    `Guilds: ${cfg.guilds.map(g => g.name).join(", ") || "none (the bot will still accept DMs)"}`,
    "",
    "The following tools are now available (will appear on next turn):",
    "  - check_discord_inbox: Review unread messages from your DM and guild inboxes",
    "  - react_message: Add/remove emoji reactions on Discord messages",
    "  - reply_discord: Send messages or reply to a specific Discord message",
    "",
    "Behavior:",
    `  - Guild messages: ${cfg.behavior.requireMention ? "Only respond when @mentioned, others go to inbox" : "Respond to all messages"}`,
    `  - DMs: Always respond`,
    `  - Inbox reminders: Every ${Math.round(cfg.behavior.inboxReminderIntervalMs / 60000)} minutes`,
    `  - Reaction notifications: ${cfg.behavior.reactionNotifyMode}`,
  ].join("\n");
}

async function handleReset(ctx: AgentContext): Promise<string> {
  await destroyDiscordClient();
  await resetConfig(ctx);

  return [
    "Discord configuration has been reset.",
    "",
    "What was removed:",
    "  - Bot token and connection settings (config.json)",
    "  - Guild snapshots (guilds/)",
    "",
    "What was preserved:",
    "  - Inbox message history (inbox/)",
    "  - Chat history is preserved in inbox/",
    "",
    "All Discord operation tools will disappear on the next turn.",
    "To set up a new bot, call setup_discord(action: 'status') to begin.",
  ].join("\n");
}
