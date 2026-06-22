// @desc Discord.js Client singleton — shared between plugin and tools via acquire/release refcounting
import { Client, GatewayIntentBits, type ClientOptions } from "discord.js";

let _client: Client | null = null;
let _refCount = 0;

const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessageReactions,
];

/** Read-only access to the shared client. Does not affect refcount. */
export function getDiscordClient(): Client | null {
  return _client;
}

/**
 * Acquire a shared Discord client. Increments refcount.
 * If no client exists, creates one and logs in. If already connected, returns the existing client.
 */
export async function acquireClient(token: string): Promise<Client> {
  _refCount++;
  if (_client) return _client;

  const opts: ClientOptions = {
    intents: REQUIRED_INTENTS,
  };

  _client = new Client(opts);
  await _client.login(token);
  return _client;
}

/**
 * Release a reference to the shared client. Decrements refcount.
 * When refcount reaches zero, the client is destroyed.
 */
export async function releaseClient(): Promise<void> {
  _refCount = Math.max(0, _refCount - 1);
  if (_refCount > 0 || !_client) return;
  try {
    _client.removeAllListeners();
    await _client.destroy();
  } catch { /* best-effort */ }
  _client = null;
}

/**
 * Force-destroy the client, ignoring refcount.
 * Use only for hard-reset scenarios (e.g. setup_discord reset action).
 * Normal plugin stop/reconnect should use releaseClient() instead.
 */
export async function destroyDiscordClient(): Promise<void> {
  _refCount = 0;
  if (!_client) return;
  try {
    _client.removeAllListeners();
    await _client.destroy();
  } catch { /* best-effort */ }
  _client = null;
}

/**
 * Validate a token by calling the Discord REST API (no gateway connection).
 * Returns bot user info on success, throws on failure.
 */
export async function validateToken(token: string): Promise<{
  id: string;
  username: string;
  discriminator: string;
  tag: string;
  applicationId: string;
}> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord API returned ${res.status}: ${body}`);
  }

  const user = (await res.json()) as {
    id: string;
    username: string;
    discriminator: string;
    bot: boolean;
  };

  if (!user.bot) {
    throw new Error("The provided token does not belong to a bot user.");
  }

  const tag = user.discriminator === "0"
    ? user.username
    : `${user.username}#${user.discriminator}`;

  const appRes = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  let applicationId = user.id;
  if (appRes.ok) {
    const app = (await appRes.json()) as { id: string };
    applicationId = app.id;
  }

  return { id: user.id, username: user.username, discriminator: user.discriminator, tag, applicationId };
}

/**
 * Fetch guilds the bot is currently a member of via REST.
 */
export async function fetchBotGuilds(token: string): Promise<Array<{ id: string; name: string; icon: string | null }>> {
  const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch guilds: ${res.status}`);
  }

  return (await res.json()) as Array<{ id: string; name: string; icon: string | null }>;
}
