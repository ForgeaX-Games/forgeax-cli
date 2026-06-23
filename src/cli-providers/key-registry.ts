// Single source of truth for LLM API keys + routes.
//
// File: <project-root>/.forgeax/keys.yaml  (hand-editable; UI later)
//
// Goals:
//   1. ONE place to rotate a key.  Change keys.yaml → claude-code + codex +
//      forgeax cli daemon all pick it up.
//   2. Adding a new CLI provider (Gemini / Hermes / ...) is just one route
//      line + the provider class — no .env juggling, no config-file edits.
//   3. Backward compatible: if keys.yaml is missing or a route is undefined,
//      consumers fall back to reading $ROOT/.env directly.
//
// Schema (YAML):
//   version: 1
//   providers:
//     <name>:
//       key: sk-...
//       base_url: https://...
//       supports: [anthropic-messages, openai-chat, openai-responses]
//       description: (optional)
//   routes:
//     claude-code:        <provider-name>     # server's ClaudeCodeProvider
//     codex:              <provider-name>     # server's CodexProvider
//     forgeax.anthropic:  <provider-name>     # cli daemon's anthropic section
//     forgeax.gpt:        <provider-name>     # cli daemon's openai-responses section
//
// `routes.<name>` is matched verbatim — no implicit fallback chain. Add new
// CLI providers by adding a new route key + corresponding consumer code.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defaultProjectRoot } from '../api/lib/safe-path';

/** Wire protocols a provider endpoint can speak. Consumers declare which one
 *  they need; the registry checks `supports` includes it before resolving. */
export type WireProtocol =
  | 'anthropic-messages'   // POST /v1/messages
  | 'openai-chat'          // POST /v1/chat/completions
  | 'openai-responses';    // POST /v1/responses

export interface ProviderEntry {
  key: string;
  base_url: string;
  supports: WireProtocol[];
  description?: string;
}

export interface KeysConfig {
  version: number;
  providers: Record<string, ProviderEntry>;
  routes: Record<string, string>;
}

export interface ResolvedRoute {
  /** Provider name (e.g. "forgeax"). */
  provider: string;
  key: string;
  base_url: string;
  supports: WireProtocol[];
}

/** Default path: <project-root>/.forgeax/keys.yaml. */
export function keysYamlPath(projectRoot?: string): string {
  const root = projectRoot ?? defaultProjectRoot();
  return resolve(root, '.forgeax', 'keys.yaml');
}

// ─── Cache ────────────────────────────────────────────────────────────────
// Re-read on mtime change so hot edits via Studio UI or `vim keys.yaml`
// take effect on the next chat() without restarting the server.

interface CacheEntry {
  mtimeMs: number;
  data: KeysConfig | null;
  loadErr: string | null;
}
const _cache = new Map<string, CacheEntry>();

/** Load + parse keys.yaml. Returns null on missing/malformed file (caller
 *  decides whether that's fatal — typically falls back to legacy env). The
 *  same returned object is cached and re-handed out until mtime changes. */
export function loadKeysConfig(projectRoot?: string): KeysConfig | null {
  const p = keysYamlPath(projectRoot);
  if (!existsSync(p)) return null;

  const st = statSync(p);
  const cached = _cache.get(p);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;

  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = parseYaml(raw) as Partial<KeysConfig> | null;
    if (!parsed || typeof parsed !== 'object') {
      _cache.set(p, { mtimeMs: st.mtimeMs, data: null, loadErr: 'not an object' });
      return null;
    }
    const data: KeysConfig = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      providers: parsed.providers && typeof parsed.providers === 'object'
        ? (parsed.providers as Record<string, ProviderEntry>)
        : {},
      routes: parsed.routes && typeof parsed.routes === 'object'
        ? (parsed.routes as Record<string, string>)
        : {},
    };
    _cache.set(p, { mtimeMs: st.mtimeMs, data, loadErr: null });
    return data;
  } catch (e) {
    const err = (e as Error).message;
    console.warn(`[key-registry] failed to parse ${p}: ${err}`);
    _cache.set(p, { mtimeMs: st.mtimeMs, data: null, loadErr: err });
    return null;
  }
}

/** Resolve a route name (e.g. "claude-code") to the concrete key + base_url.
 *  Returns null if keys.yaml is missing, the route is undefined, or the
 *  target provider entry doesn't exist. Caller falls back to legacy behaviour. */
export function resolveRoute(routeName: string, projectRoot?: string): ResolvedRoute | null {
  const cfg = loadKeysConfig(projectRoot);
  if (!cfg) return null;
  const providerName = cfg.routes[routeName];
  if (!providerName) return null;
  const entry = cfg.providers[providerName];
  if (!entry || !entry.key) {
    console.warn(`[key-registry] route '${routeName}' → '${providerName}' but provider entry missing/empty`);
    return null;
  }
  return {
    provider: providerName,
    key: entry.key,
    base_url: entry.base_url,
    supports: Array.isArray(entry.supports) ? entry.supports : [],
  };
}

/** Mask a key for UI display. First 4 + last 4 around an ellipsis; short
 *  keys collapse to `***`. */
export function maskKey(v: string | undefined): string | null {
  if (!v) return null;
  if (v.length <= 8) return '***';
  return `${v.slice(0, 4)}...${v.slice(-4)}`;
}

/** Friendly summary of all routes — used by /api/keys for the Settings UI. */
export interface RouteSummary {
  route: string;
  provider: string | null;
  key: string | null;
  base_url: string | null;
  supports: WireProtocol[];
}

export function listRoutes(projectRoot?: string): RouteSummary[] {
  const cfg = loadKeysConfig(projectRoot);
  if (!cfg) return [];
  const out: RouteSummary[] = [];
  for (const [route, providerName] of Object.entries(cfg.routes)) {
    const entry = cfg.providers[providerName];
    out.push({
      route,
      provider: providerName,
      key: entry ? maskKey(entry.key) : null,
      base_url: entry?.base_url ?? null,
      supports: entry?.supports ?? [],
    });
  }
  return out;
}

/** List providers (with keys masked) — used by /api/keys. */
export interface ProviderSummary {
  name: string;
  key: string | null;
  base_url: string;
  supports: WireProtocol[];
  description: string | null;
}

export function listProviders(projectRoot?: string): ProviderSummary[] {
  const cfg = loadKeysConfig(projectRoot);
  if (!cfg) return [];
  return Object.entries(cfg.providers).map(([name, entry]) => ({
    name,
    key: maskKey(entry.key),
    base_url: entry.base_url,
    supports: entry.supports ?? [],
    description: entry.description ?? null,
  }));
}

/** Detect stale legacy env vars that shadow a keys.yaml route. Emits a
 *  one-time warning at server boot so operators know to clean up `.env`. */
export function detectStaleEnvShadows(): Array<{ envVar: string; route: string }> {
  const cfg = loadKeysConfig();
  if (!cfg) return [];
  const shadows: Array<{ envVar: string; route: string }> = [];
  if (cfg.routes['claude-code'] && process.env.ANTHROPIC_API_KEY) {
    shadows.push({ envVar: 'ANTHROPIC_API_KEY', route: 'claude-code' });
  }
  if (cfg.routes['codex'] && process.env.OPENAI_API_KEY) {
    shadows.push({ envVar: 'OPENAI_API_KEY', route: 'codex' });
  }
  return shadows;
}

/** Detect ~/.claude/settings.json env block that shadows the claude-code
 *  route. The user-level claude CLI settings file (very common — populated by
 *  the `claude /init` flow) has its `env` block applied to every subprocess,
 *  so even when forgeax injects ANTHROPIC_API_KEY via spawn env, it gets
 *  overridden silently. This detector reads the file and reports the
 *  conflict so the server can warn at boot.
 *
 *  Returns null if file doesn't exist or has no env.ANTHROPIC_API_KEY. */
export function detectClaudeSettingsShadow(): {
  settingsPath: string;
  shadowedKey: string;        // masked
  routeProvider: string;
  routeKey: string;            // masked
  match: boolean;              // true ↔ same key as keys.yaml route (no risk)
} | null {
  const cfg = loadKeysConfig();
  if (!cfg) return null;
  const routeName = cfg.routes['claude-code'];
  if (!routeName) return null;
  const route = cfg.providers[routeName];
  if (!route?.key) return null;

  // claude CLI settings.json lives at $HOME/.claude/settings.json.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const settingsPath = resolve(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return null;

  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const j = JSON.parse(raw) as { env?: Record<string, string> };
    const shadowed = j.env?.ANTHROPIC_API_KEY;
    if (!shadowed) return null;
    return {
      settingsPath,
      shadowedKey: maskKey(shadowed) ?? '?',
      routeProvider: routeName,
      routeKey: maskKey(route.key) ?? '?',
      match: shadowed === route.key,
    };
  } catch {
    return null;
  }
}
