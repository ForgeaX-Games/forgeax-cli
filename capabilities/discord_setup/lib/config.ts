// @desc Discord config helpers — path resolution and persistent config R/W under homes/{agentId}/discord/
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { AgentContext } from "#src/core/types.js";

export interface DiscordGuildRef {
  id: string;
  name: string;
  joinedAt: string;
}

export interface DiscordBehavior {
  requireMention: boolean;
  inboxReminderIntervalMs: number;
  reactionNotifyMode: "off" | "own" | "all";
}

export interface DiscordConfig {
  token: string;
  applicationId: string;
  botId: string;
  botUsername: string;
  guilds: DiscordGuildRef[];
  behavior: DiscordBehavior;
  finalized: boolean;
  createdAt: string;
}

const DEFAULT_BEHAVIOR: DiscordBehavior = {
  requireMention: true,
  inboxReminderIntervalMs: 30 * 60 * 1000,
  reactionNotifyMode: "own",
};

// ── Path helpers ──

export function discordHome(ctx: AgentContext): string {
  return join(ctx.pathManager.team().homeFor(ctx.agentId), "discord");
}

export function discordConfigPath(ctx: AgentContext): string {
  return join(discordHome(ctx), "config.json");
}

export function discordInboxDir(ctx: AgentContext): string {
  return join(discordHome(ctx), "inbox");
}

export function discordGuildsDir(ctx: AgentContext): string {
  return join(discordHome(ctx), "guilds");
}

// ── Config R/W ──

export function loadConfig(ctx: AgentContext): DiscordConfig | null {
  const p = discordConfigPath(ctx);
  if (!getSandboxFs().existsSync(p)) return null;
  try {
    return JSON.parse(getSandboxFs().readTextSync(p)) as DiscordConfig;
  } catch {
    return null;
  }
}

export function saveConfig(ctx: AgentContext, cfg: DiscordConfig): void {
  const dir = discordHome(ctx);
  getSandboxFs().mkdirSync(dir);
  getSandboxFs().writeTextSync(discordConfigPath(ctx), JSON.stringify(cfg, null, 2) + "\n");
}

export function createPartialConfig(token: string, appId: string, botId: string, botUsername: string): DiscordConfig {
  return {
    token,
    applicationId: appId,
    botId,
    botUsername,
    guilds: [],
    behavior: { ...DEFAULT_BEHAVIOR },
    finalized: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Reset: delete config.json and guilds/, preserve inbox/ history.
 */
export function resetConfig(ctx: AgentContext): void {
  const home = discordHome(ctx);
  const configPath = join(home, "config.json");
  const guildsPath = join(home, "guilds");

  try { getSandboxFs().rmSync(configPath, { force: true }); } catch { /* ignore */ }
  try { getSandboxFs().rmSync(guildsPath, { recursive: true, force: true }); } catch { /* ignore */ }
}
