// @desc Slot — Discord bot connection status, identity, and joined guilds
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { SlotFactory, ContextSlot } from "#src/capability/slot/types.js";
import { SlotPriority } from "#src/capability/slot/types.js";
import { getDiscordClient } from "../../discord_setup/lib/discord-client.js";

interface DiscordConfig {
  botUsername?: string;
  botId?: string;
  guilds?: Array<{ name: string; id: string }>;
}

const create: SlotFactory = (ctx) => {
  const configPath = join(ctx.pathManager.team().homeFor(ctx.agentId), "discord", "config.json");

  const slot: ContextSlot = {
    name: "discord-status",
    priority: SlotPriority.DYNAMIC_CONTEXT,
    cacheHint: "dynamic",
    version: 0,

    content: () => {
      const fs = getSandboxFs();
      let cfg: DiscordConfig | null = null;
      if (!fs.existsSync(configPath)) return "";
      try { cfg = JSON.parse(fs.readTextSync(configPath)) as DiscordConfig; }
      catch { return ""; }

      const client = getDiscordClient();
      const online = client?.isReady() ?? false;
      const status = online ? "online" : "offline";
      const identity = `${cfg.botUsername ?? "unknown"} (ID: ${cfg.botId ?? "?"})`;
      const guilds = (cfg.guilds ?? []).map(g => g.name).join(", ") || "none";
      return `[Discord: ${status} | ${identity} | guilds: ${guilds}]`;
    },
  };

  return slot;
};

export default create;
