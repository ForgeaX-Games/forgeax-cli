/**
 * /api/settings — system settings drawer backend.
 *
 *   GET  /api/settings                 → { env: { ... masked }, paths }
 *   PUT  /api/settings/env             → patch $ROOT/.env (atomic write); keys not in body left alone
 *   POST /api/settings/reset-sessions  → close + rm -rf every session dir under <userRoot>/sessions/
 *
 * Note: llm_key.json was retired 2026-05. All LLM credentials live in .env;
 * routing is decided by id pattern (see src/llm/auto-resolver.ts). The
 * `/llmkey` endpoint and the `llmKeyConfigured` field are gone.
 */

import { Hono } from 'hono';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultProjectRoot } from './lib/safe-path';
import { friendlyPath } from './lib/friendly-path';
import { getSessionManager } from '../core/session-manager';

const SAFE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'FORGEAX_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  // wb-character & other multimodal plugins — image / video keys. See
  // src/lib/image-gateway/clients/dispatcher.ts for the
  // primary/fallback chain (seedream → gemini → azure-gpt-image).
  'ARK_IMAGE_KEY',
  'ARK_VIDEO_KEY',
  'AZURE_GPT_IMAGE_KEY',
  'AZURE_GPT_IMAGE_ENDPOINT',
  'AZURE_GPT_IMAGE_DEPLOYMENT',
  'LITELLM_PROXY_KEY',
  'LITELLM_PROXY_BASE_URL',
  // 直连 DeepSeek (deepseek-v4 provider; llm provider 读这俩 var).
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
]);

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function serializeEnv(env: Record<string, string>, original?: string): string {
  // Preserve any comments / unknown lines from the original, just update
  // recognized keys in place; append new keys at the end.
  const seen = new Set<string>();
  const lines: string[] = [];
  if (original) {
    for (const line of original.split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
      if (m && env[m[1]] !== undefined) {
        lines.push(`${m[1]}=${env[m[1]]}`);
        seen.add(m[1]);
      } else {
        lines.push(line);
      }
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  return lines.join('\n');
}

/**
 * Mask a secret for safe rendering in the Settings drawer. Never let the
 * raw value cross the network — short keys collapse to `***`, longer keys
 * show first-4 + last-4 around an ellipsis so users can still recognise
 * which key is set without exposing enough for token theft.
 *
 * Exported (instead of file-local) so the format contract has a unit test
 * — the UI parses these strings literally; a future "improvement" to the
 * shape would silently break the drawer's reveal/edit toggle.
 */
export function maskKey(v: string | undefined): string | null {
  if (!v) return null;
  if (v.length <= 8) return '***';
  return `${v.slice(0, 4)}...${v.slice(-4)}`;
}

export function createSettingsRouter(): Hono {
  const r = new Hono();

  r.get('/', async (c) => {
    const projectRoot = defaultProjectRoot();
    const envPath = resolve(projectRoot, '.env');
    let env: Record<string, string> = {};
    if (existsSync(envPath)) {
      try { env = parseEnv(await readFile(envPath, 'utf-8')); } catch { /* */ }
    }
    return c.json({
      env: {
        ANTHROPIC_API_KEY: maskKey(env.ANTHROPIC_API_KEY),
        ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? null,
        FORGEAX_MODEL: env.FORGEAX_MODEL ?? null,
        OPENAI_API_KEY: maskKey(env.OPENAI_API_KEY),
        OPENAI_BASE_URL: env.OPENAI_BASE_URL ?? null,
        GEMINI_API_KEY: maskKey(env.GEMINI_API_KEY),
        ARK_IMAGE_KEY: maskKey(env.ARK_IMAGE_KEY),
        ARK_VIDEO_KEY: maskKey(env.ARK_VIDEO_KEY),
        AZURE_GPT_IMAGE_KEY: maskKey(env.AZURE_GPT_IMAGE_KEY),
        AZURE_GPT_IMAGE_ENDPOINT: env.AZURE_GPT_IMAGE_ENDPOINT ?? null,
        AZURE_GPT_IMAGE_DEPLOYMENT: env.AZURE_GPT_IMAGE_DEPLOYMENT ?? null,
        LITELLM_PROXY_KEY: maskKey(env.LITELLM_PROXY_KEY),
        LITELLM_PROXY_BASE_URL: env.LITELLM_PROXY_BASE_URL ?? null,
        DEEPSEEK_API_KEY: maskKey(env.DEEPSEEK_API_KEY),
        DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL ?? null,
      },
      // UI displays these in the "关于" section — redact $HOME → ~ for
      // portability + privacy hygiene (was leaking operator home prefix).
      paths: {
        projectRoot: friendlyPath(projectRoot),
        envPath: friendlyPath(envPath),
      },
    });
  });

  r.put('/env', async (c) => {
    let body: Record<string, string>;
    try { body = (await c.req.json()) as Record<string, string>; }
    catch { return c.json({ error: 'invalid json' }, 400); }
    const projectRoot = defaultProjectRoot();
    const envPath = resolve(projectRoot, '.env');
    let originalText = '';
    let env: Record<string, string> = {};
    if (existsSync(envPath)) {
      originalText = await readFile(envPath, 'utf-8');
      env = parseEnv(originalText);
    }
    // Only allow whitelisted keys to be patched.
    let touched = 0;
    for (const [k, v] of Object.entries(body)) {
      if (!SAFE_ENV_KEYS.has(k)) continue;
      if (typeof v !== 'string') continue;
      env[k] = v;
      process.env[k] = v;   // live-apply so the running server picks it up without a restart (U3 first-run onboarding)
      touched++;
    }
    if (touched === 0) return c.json({ error: 'no recognized keys in body', allowed: [...SAFE_ENV_KEYS] }, 400);
    try {
      await writeFile(envPath, serializeEnv(env, originalText), 'utf-8');
      return c.json({ ok: true, touched, envPath: friendlyPath(envPath) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  r.post('/reset-sessions', async (c) => {
    const sm = getSessionManager();
    const entries = sm.list();
    let removed = 0;
    const failed: { sid: string; error: string }[] = [];
    for (const e of entries) {
      try { await sm.delete(e.sid); removed++; }
      catch (err: any) { failed.push({ sid: e.sid, error: err?.message ?? String(err) }); }
    }
    if (failed.length > 0) {
      return c.json({ ok: false, removed, failed, error: `${failed.length} session(s) failed to delete` }, 500);
    }
    return c.json({ ok: true, removed });
  });

  // /llmkey was retired 2026-05 with llm_key.json. Surface a 410 so the old
  // SettingsDrawer build (still cached in some browsers) shows a clear
  // "edit .env instead" hint rather than a silent 404.
  r.put('/llmkey', (c) => c.json({
    error: 'llm_key.json retired — set credentials in $ROOT/.env instead',
    hint: 'PUT /api/settings/env with ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / LITELLM_PROXY_KEY etc',
  }, 410));

  return r;
}
