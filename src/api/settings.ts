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
import { defaultProjectRoot } from '@forgeax/platform-io';
import { friendlyPath } from '@forgeax/platform-io';
import { getSessionManager } from '../core/session-manager';
import { DEFAULT_UPLOAD_REPO } from '../upload/config';

const SAFE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  // OpenRouter (default backend) auth — claude-code reads ANTHROPIC_AUTH_TOKEN
  // as a Bearer token; the OpenRouter key (sk-or-...) goes here while
  // ANTHROPIC_API_KEY is blanked. See FirstRunSetup onboarding + OpenRouter's
  // claude-code integration guide (https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'FORGEAX_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  // wb-character & other multimodal plugins — image / video keys. See
  // src/lib/image-gateway/clients/dispatcher.ts for the
  // primary/fallback chain (seedream → gemini → azure-gpt-image).
  'ARK_IMAGE_KEY',
  // NOTE: when adding an LLM auth/routing key here, also add it to
  // SIDECAR_CRED_KEYS below so a settings change restarts the sidecar
  // (whose cred-vault froze the old credential at spawn time).
  'ARK_VIDEO_KEY',
  'AZURE_GPT_IMAGE_KEY',
  'AZURE_GPT_IMAGE_ENDPOINT',
  'AZURE_GPT_IMAGE_DEPLOYMENT',
  'LITELLM_PROXY_KEY',
  'LITELLM_PROXY_BASE_URL',
  // 直连 DeepSeek (deepseek-v4 provider; llm provider 读这俩 var).
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  // Workspace → GitHub upload (see src/upload). All three are drawer-editable.
  // Decision 2026-07-09: FORGEAX_UPLOAD_REPO is user-configurable (default =
  // DEFAULT_UPLOAD_REPO shared org repo) — users may upload to any repo their own
  // token can write. Residual risk of a network-repointable destination is
  // accepted pending the loopback hardening (server binds 127.0.0.1 in dev-local).
  'FORGEAX_UPLOAD_GITHUB_TOKEN',
  'FORGEAX_UPLOAD_REPO',
  'FORGEAX_UPLOAD_BRANCH',
]);

/**
 * The .env credentials file is INSTALL-GLOBAL, not per-workspace.
 *
 * The server loads $ROOT/.env once at boot (run.ts) into process.env; those
 * credentials + FORGEAX_MODEL are process-global and survive a workspace
 * hot-switch (POST /api/workspaces/activate only remaps FORGEAX_PROJECT_ROOT).
 * If Settings read/wrote `<defaultProjectRoot()>/.env` it would follow the
 * MUTABLE active workspace root — so activating a fresh workspace made the
 * drawer read that new root's (empty) .env: keys vanished, FORGEAX_MODEL reset
 * to the fallback, and the "connect a model" gate fired even though the running
 * server still had valid creds in process.env. Anchor to the file the server
 * actually loaded (FORGEAX_ENV_FILE, exported by run.ts) so credentials are
 * stable across workspaces. Fallback keeps the packaged app / tests unchanged.
 */
function envFilePath(): string {
  const explicit = process.env.FORGEAX_ENV_FILE;
  if (explicit && explicit.trim()) return explicit;
  return resolve(defaultProjectRoot(), '.env');
}

// LLM 鉴权/路由类 key —— 这些 key 的真值被 sidecar(agent-host)的 cred-vault 在**子进程
// spawn 时冻结**(cred-vault issueScoped 现取 ANTHROPIC_API_KEY、转发时现取 ANTHROPIC_BASE_URL,
// 均从冻结的 process.env 读)。仅把新值写进 .env + live-apply server 自己的 process.env 到不了
// 已在跑的 sidecar,故这些 key 变更后必须重启 sidecar,否则新凭据要等整进程重启才生效
// (正是本 bug:设置 litellm key 不生效,必须改 .env + 重启)。model/多模态图像 key 不在此列:
// model 每轮下发、图像 key 由 server 侧插件现读 process.env,无需重启 sidecar。
const SIDECAR_CRED_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'LITELLM_PROXY_KEY',
  'LITELLM_PROXY_BASE_URL',
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
  if (v.length <= 8) return '****';
  // Middle-starred so a saved key reads as clearly PRESENT (not an empty field)
  // while leaking only the head/tail the owner already knows.
  return `${v.slice(0, 4)}********${v.slice(-4)}`;
}

export function createSettingsRouter(): Hono {
  const r = new Hono();

  r.get('/', async (c) => {
    const projectRoot = defaultProjectRoot();
    const envPath = envFilePath();
    let env: Record<string, string> = {};
    if (existsSync(envPath)) {
      try { env = parseEnv(await readFile(envPath, 'utf-8')); } catch { /* */ }
    }
    return c.json({
      env: {
        ANTHROPIC_API_KEY: maskKey(env.ANTHROPIC_API_KEY),
        ANTHROPIC_AUTH_TOKEN: maskKey(env.ANTHROPIC_AUTH_TOKEN),
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
        // Workspace upload — a masked token represents an env override; null
        // means no override, so upload uses the compiled built-in fallback. Repo
        // shows the effective destination (env override or shared default).
        FORGEAX_UPLOAD_GITHUB_TOKEN: maskKey(env.FORGEAX_UPLOAD_GITHUB_TOKEN),
        FORGEAX_UPLOAD_REPO: env.FORGEAX_UPLOAD_REPO?.trim() || DEFAULT_UPLOAD_REPO,
        FORGEAX_UPLOAD_BRANCH: env.FORGEAX_UPLOAD_BRANCH ?? null,
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
    const envPath = envFilePath();
    let originalText = '';
    let env: Record<string, string> = {};
    if (existsSync(envPath)) {
      originalText = await readFile(envPath, 'utf-8');
      env = parseEnv(originalText);
    }
    // Only allow whitelisted keys to be patched.
    let touched = 0;
    let credChanged = false;   // 某个 LLM 鉴权/路由 key 的**值**变了 → 需重启 sidecar
    for (const [k, v] of Object.entries(body)) {
      if (!SAFE_ENV_KEYS.has(k)) continue;
      if (typeof v !== 'string') continue;
      if (SIDECAR_CRED_KEYS.has(k) && (env[k] ?? '') !== v) credChanged = true;
      env[k] = v;
      process.env[k] = v;   // live-apply so the running server picks it up without a restart (U3 first-run onboarding)
      touched++;
    }
    if (touched === 0) return c.json({ error: 'no recognized keys in body', allowed: [...SAFE_ENV_KEYS] }, 400);
    try {
      await writeFile(envPath, serializeEnv(env, originalText), 'utf-8');
      // sidecar 的 cred-vault 冻结了旧凭据(spawn 时的 env 快照)——重启它,让下一次对话用
      // 刚写入的新凭据 spawn。不重启则新 key/base-url 要等整进程重启才生效(本 bug 根因)。
      // best-effort:重启失败不该让"已保存"的写回退;失败只记 warning,用户仍可手动重启兜底。
      if (credChanged) {
        try {
          const { restartSidecar } = await import('../kernel/sidecar-singleton');
          await restartSidecar();
        } catch (e) {
          console.warn(`[settings] 凭据已写入 .env,但 sidecar 重启失败(新凭据可能要手动重启才生效):${(e as Error).message}`);
        }
      }
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
