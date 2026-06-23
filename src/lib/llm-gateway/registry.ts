/**
 * ModelRegistry — gateway-side `model → {transport, apiKey, baseUrl}` resolver.
 *
 * Post-llm_key.json retirement (2026-05): every routing decision derives from
 * `.env` + the model id pattern, via [[resolveModelAdapter]] in
 * `src/llm/auto-resolver.ts`. The vault layer is gone — there's no per-section
 * mapping anymore. `resolveBySection` is preserved as a no-op for legacy call
 * sites (none in-tree); `listResolvedModels` returns the empty list (UI moved
 * to the `list_models` command which reads the picker catalog directly).
 */
import { resolveModelAdapter } from '../../llm/auto-resolver';

export const DEFAULT_API_TO_TRANSPORT: Record<string, string> = {
  'anthropic-messages': 'litellm',
  'openai-responses': 'litellm',
  'openai-compat': 'litellm',
  'google-gemini-2': 'litellm',
  'google-gemini-3': 'litellm',
  'deepseek-v4': 'litellm',
};

export interface ResolvedModel {
  model: string;
  transport: string;
  apiKey: string;
  baseUrl?: string;
  /** Legacy field — always `<env:auto-resolver>` post-retirement. */
  section: string;
  /** Adapter type (e.g. "anthropic-messages"). */
  api: string;
}

export interface ModelRegistryOpts {
  apiToTransport?: Record<string, string>;
  defaultTransport?: string;
}

export class ModelRegistry {
  private readonly apiToTransport: Record<string, string>;
  private readonly defaultTransport: string;

  constructor(opts: ModelRegistryOpts = {}) {
    this.apiToTransport = { ...DEFAULT_API_TO_TRANSPORT, ...(opts.apiToTransport ?? {}) };
    this.defaultTransport = opts.defaultTransport ?? 'litellm';
  }

  resolveModel(model: string): ResolvedModel | null {
    try {
      const r = resolveModelAdapter(model, process.env);
      const transport = this.apiToTransport[r.api] ?? this.defaultTransport;
      return {
        model,
        transport,
        apiKey: r.apiKey,
        baseUrl: r.apiBase,
        section: '<env:auto-resolver>',
        api: r.api,
      };
    } catch {
      return null;
    }
  }

  resolveBySection(_model: string, _sectionName: string): ResolvedModel | null {
    return null;
  }

  /** Bare-litellm fallback for tooling that needs proxy creds without naming
   *  a specific model. Returns null when LITELLM_PROXY_* aren't set. */
  resolveLitellmFallback(envOverride?: Record<string, string | undefined>): ResolvedModel | null {
    const env = envOverride ?? (process.env as Record<string, string | undefined>);
    const apiKey = env.LITELLM_PROXY_KEY;
    const baseUrl = env.LITELLM_PROXY_BASE_URL;
    if (!apiKey || !baseUrl) return null;
    return {
      model: '',
      transport: 'litellm',
      apiKey,
      baseUrl,
      section: '<env:litellm>',
      api: 'litellm-proxy',
    };
  }

  /** Empty post-retirement: callers wanting the live picker catalog should
   *  invoke the `list_models` command (builtin/commands/models.ts) which
   *  reads `~/.forgeax/key/models.json` + the live `/v1/models` proxy. */
  listResolvedModels(): ResolvedModel[] {
    return [];
  }
}

let _default: ModelRegistry | null = null;

export function getDefaultRegistry(): ModelRegistry {
  if (!_default) _default = new ModelRegistry();
  return _default;
}

export function _resetDefaultRegistryForTests(): void {
  _default = null;
}
