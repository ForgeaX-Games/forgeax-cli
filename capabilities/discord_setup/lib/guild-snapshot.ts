// @desc Discord guild snapshot — persist guild info (channels, roles, members) to disk
import { join } from "node:path";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import type { Guild } from "discord.js";

export interface GuildSnapshot {
  id: string;
  name: string;
  icon: string | null;
  channels: Array<{ id: string; name: string; type: string }>;
  memberCount: number;
  botRoles: string[];
  updatedAt: string;
}

export async function writeGuildSnapshot(guildsDir: string, guild: Guild): Promise<GuildSnapshot> {
  getSandboxFs().mkdirSync(guildsDir);

  const textChannels = guild.channels.cache
    .filter(ch => ch.isTextBased() && !ch.isThread())
    .map(ch => ({
      id: ch.id,
      name: ch.name,
      type: ch.type === 0 ? "text" : ch.type === 2 ? "voice" : String(ch.type),
    }));

  const botMember = guild.members.me;
  const botRoles = botMember
    ? botMember.roles.cache.filter(r => r.name !== "@everyone").map(r => r.name)
    : [];

  const snapshot: GuildSnapshot = {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL(),
    channels: textChannels,
    memberCount: guild.memberCount,
    botRoles,
    updatedAt: new Date().toISOString(),
  };

  getSandboxFs().writeTextSync(
    join(guildsDir, `${guild.id}.json`),
    JSON.stringify(snapshot, null, 2) + "\n",
  );

  return snapshot;
}

export function readGuildSnapshot(guildsDir: string, guildId: string): GuildSnapshot | null {
  const p = join(guildsDir, `${guildId}.json`);
  if (!getSandboxFs().existsSync(p)) return null;
  try {
    return JSON.parse(getSandboxFs().readTextSync(p)) as GuildSnapshot;
  } catch {
    return null;
  }
}
