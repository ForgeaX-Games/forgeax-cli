// llm-gateway — plugin-facing one-shot text completion router.
//
// Stage C contract:
//   gateway.llm.complete({model, messages, temperature?, ...}) → {text, ...}
//   gateway.llm.registerTransport(transport)
//   gateway.llm.parseModelSpec("model@keySection")  (re-exported convenience)
//
// Why a separate gateway when src/llm/provider.ts already exists:
//   provider.ts is the streaming session-loop router with retries / fallback
//   chains / agent.json wiring. Plugins that just want "send this prompt, give
//   me text back" don't want any of that. This gateway is the thin surface that
//   stays compatible with the agentic_os MODEL_MAP idiom (parseModelSpec for
//   `model@keySection`) so familiar muscle memory carries over.
//
// Transport selection precedence:
//   1. explicit `req.transport`
//   2. MODEL_MAP prefix → transport name
//   3. default = 'litellm' (the studio's proxy fans out to all upstream vendors)

import type { CompleteRequest, CompleteResponse, LlmTransport, TransportOpts } from './types';
import { litellmTransport } from './transports/litellm';
import { getDefaultRegistry, type ModelRegistry } from './registry';

export * from './types';
export { fetchLiveCatalog, _resetLiveCatalogCache } from './live-catalog';
export {
  ModelRegistry,
  getDefaultRegistry,
  _resetDefaultRegistryForTests,
  DEFAULT_API_TO_TRANSPORT,
  type ResolvedModel,
} from './registry';

const transports = new Map<string, LlmTransport>();
const modelMap: Array<{ prefix: string; transport: string }> = [];

export function registerTransport(t: LlmTransport): void {
  transports.set(t.name, t);
}

export function unregisterTransport(name: string): void {
  transports.delete(name);
}

export function listTransports(): string[] {
  return Array.from(transports.keys());
}

/** Bind a model-id prefix to a transport. Longest prefix wins (last writer
 *  wins for ties). Plugins can override defaults without forking the gateway. */
export function registerModelMapping(prefix: string, transportName: string): void {
  const idx = modelMap.findIndex((m) => m.prefix === prefix);
  if (idx >= 0) modelMap[idx].transport = transportName;
  else modelMap.push({ prefix, transport: transportName });
  modelMap.sort((a, b) => b.prefix.length - a.prefix.length);
}

export function resolveTransport(model: string): string {
  for (const m of modelMap) {
    if (model.startsWith(m.prefix)) return m.transport;
  }
  return 'litellm';
}

/** `model@keySection` syntax mirrors src/llm/provider.ts so callers can hop
 *  between gateways without relearning. Empty keySection = default routing. */
export function parseModelSpec(raw: string): { model: string; keySection?: string } {
  const at = raw.lastIndexOf('@');
  if (at > 0 && at < raw.length - 1) {
    return { model: raw.slice(0, at), keySection: raw.slice(at + 1) };
  }
  return { model: raw };
}

/** Resolve a request to {transport, opts} via the ModelRegistry. Opt-in:
 *  caller passes a registry (or relies on `getDefaultRegistry()`). Falls
 *  through to transport-internal env reads when the model is unknown.
 *  C6 ships this as additive plumbing — `complete()` itself stays
 *  legacy-compatible until C7 callers explicitly route through here. */
export function resolveRequestRouting(
  req: CompleteRequest,
  registry?: ModelRegistry,
): { transport: string; opts: TransportOpts } {
  const transport = req.transport ?? resolveTransport(req.model);
  const reg = registry ?? getDefaultRegistry();
  const r = reg.resolveModel(req.model);
  if (r) return { transport, opts: { apiKey: r.apiKey, baseUrl: r.baseUrl } };
  const fb = reg.resolveLitellmFallback();
  if (fb) return { transport, opts: { apiKey: fb.apiKey, baseUrl: fb.baseUrl } };
  return { transport, opts: {} };
}

export async function complete(req: CompleteRequest): Promise<CompleteResponse> {
  const transportName = req.transport ?? resolveTransport(req.model);
  const transport = transports.get(transportName);
  if (!transport) {
    throw new Error(
      `llm-gateway: no transport '${transportName}' registered for model '${req.model}'. ` +
      `Available: [${listTransports().join(', ')}]`,
    );
  }
  return transport.complete(req, {});
}

// ── Default registry — litellm covers all proxy-routed vendors ──────────────
registerTransport(litellmTransport);

/** Test-only: wipe all registered transports + model mappings + re-seed
 *  defaults. Stage C tests rely on this for hermeticity. */
export function _resetGateway(): void {
  transports.clear();
  modelMap.length = 0;
  registerTransport(litellmTransport);
}
