/** Pure model→adapter resolver. Mirror of packages/server's auto-resolver:
 *  every routing decision derives from `.env` + the model id pattern, no
 *  llm_key.json middleman.
 *
 *  Routing policy (proxy-first when configured, else direct vendor):
 *
 *    if LITELLM_PROXY_KEY + LITELLM_PROXY_BASE_URL set:
 *      claude-*                         → anthropic-messages (proxy /messages)
 *      gpt-* / codex-* / o[1-9]-*       → openai-responses   (proxy /v1)
 *      *                                → openai-compat      (proxy /v1)
 *
 *    otherwise:
 *      claude-*                         → anthropic-messages + ANTHROPIC_*
 *      gpt-* / codex-* / o[1-9]-*       → openai-responses   + OPENAI_*
 *      gemini-3*                        → google-gemini-3    + GEMINI_API_KEY
 *      gemini-*                         → google-gemini-2    + GEMINI_API_KEY
 *      deepseek-*                       → deepseek-v4        + DEEPSEEK_*
 */

export interface ResolvedAdapter {
  api: string;
  apiKey: string;
  apiBase: string | undefined;
}

function proxyConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.LITELLM_PROXY_KEY && env.LITELLM_PROXY_BASE_URL);
}

/** Strip trailing slash + trailing `/v1` from LITELLM_PROXY_BASE_URL so users
 *  carrying habit from llm_key.json (`api_base` ending in `/v1`) don't hit
 *  /v1/v1/... 404s. */
function normalizeProxyBase(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const RE_CLAUDE = /^claude-/i;
const RE_OPENAI_RESPONSES = /^(gpt-|codex-|o[1-9](-|$))/i;
const RE_GEMINI_3 = /^gemini-3/i;
const RE_GEMINI = /^gemini-/i;
const RE_DEEPSEEK = /^deepseek-/i;

export function resolveModelAdapter(model: string, env: NodeJS.ProcessEnv): ResolvedAdapter {
  if (proxyConfigured(env)) {
    const proxyKey = env.LITELLM_PROXY_KEY!;
    const proxyBase = normalizeProxyBase(env.LITELLM_PROXY_BASE_URL!);
    if (RE_CLAUDE.test(model)) {
      return { api: "anthropic-messages", apiKey: proxyKey, apiBase: proxyBase };
    }
    if (RE_OPENAI_RESPONSES.test(model)) {
      return { api: "openai-responses", apiKey: proxyKey, apiBase: `${proxyBase}/v1` };
    }
    return { api: "openai-compat", apiKey: proxyKey, apiBase: `${proxyBase}/v1` };
  }

  if (RE_CLAUDE.test(model)) {
    const apiKey = env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set ANTHROPIC_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "anthropic-messages", apiKey, apiBase: env.ANTHROPIC_BASE_URL || undefined };
  }
  if (RE_OPENAI_RESPONSES.test(model)) {
    const apiKey = env.OPENAI_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set OPENAI_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "openai-responses", apiKey, apiBase: env.OPENAI_BASE_URL || undefined };
  }
  if (RE_GEMINI_3.test(model)) {
    const apiKey = env.GEMINI_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set GEMINI_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "google-gemini-3", apiKey, apiBase: undefined };
  }
  if (RE_GEMINI.test(model)) {
    const apiKey = env.GEMINI_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set GEMINI_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "google-gemini-2", apiKey, apiBase: undefined };
  }
  if (RE_DEEPSEEK.test(model)) {
    const apiKey = env.DEEPSEEK_API_KEY ?? "";
    if (!apiKey) throw new Error(`No API key for '${model}': set DEEPSEEK_API_KEY (or LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL) in .env`);
    return { api: "deepseek-v4", apiKey, apiBase: env.DEEPSEEK_BASE_URL || undefined };
  }

  throw new Error(
    `No adapter recognizes model '${model}'. Either set LITELLM_PROXY_KEY + ` +
    `LITELLM_PROXY_BASE_URL in .env to route through the proxy, or use a model ` +
    `id matching one of: claude-*, gpt-*/codex-*/o[1-9]-*, gemini-*, deepseek-*.`,
  );
}
