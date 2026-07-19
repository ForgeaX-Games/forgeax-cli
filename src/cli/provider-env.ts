/**
 * provider-env —— env 驱动的 provider 解析(host 层 SSOT,cli/ 与 serve 共用)。
 *
 * 两个正交概念,全部协议级、零厂商/代理产品名:
 * - **api 家族**:`FORGEAX_PROVIDER_API` 显式覆盖(值 = provider/register 的 backend id,
 *   如 `openai-compat`);缺省按模型名前缀推断(pickApi)。显式覆盖的存在理由
 *   (bug-empty-response-2026-07-13):端点讲什么协议不总能从模型名推出——
 *   逻辑模型名(claude-fable-5)发给 Azure Anthropic 直连端点会被当作
 *   deployment name → 404 DeploymentNotFound,必须能声明「走 openai-compat」。
 * - **凭证**:按家族取各自的行业标准 env 对——
 *   `openai-compat` → `OPENAI_BASE_URL` / `OPENAI_API_KEY`;
 *   其余(anthropic-messages/gemini/…)→ `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`
 *   (非 anthropic 家族沿用 ANTHROPIC_* 兜底是既有行为,此处不扩大)。
 *
 * 宿主(如 studio)对具体代理产品(LiteLLM 等)的认知留在宿主层:由宿主把自己的
 * 配置翻译成上面这组中立变量注入;core 不认识任何代理产品。
 */
import { resolveProvider } from '../provider/register';
import type { LLMProvider, ProviderFactoryOpts } from '../provider/types';

/** map model → provider api family(anthropic↔openai-compat↔...)。 */
export function pickApi(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai-compat';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('deepseek')) return 'deepseek-v4';
  return 'anthropic-messages';
}

/** 解析出的 provider 配置(api 家族 + 该家族凭证);apiKey 空串 = 该家族凭证未配置。 */
export interface ProviderEnvConfig extends ProviderFactoryOpts {
  api: string;
}

/** 从 env 解析 provider 配置:FORGEAX_PROVIDER_API 覆盖家族,凭证按家族取标准 env 对。 */
export function resolveProviderEnv(model: string): ProviderEnvConfig {
  const api = process.env.FORGEAX_PROVIDER_API || pickApi(model);
  if (api === 'openai-compat') {
    return {
      api,
      apiKey: process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.OPENAI_BASE_URL,
    };
  }
  return {
    api,
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    headers: { 'anthropic-version': '2023-06-01' },
  };
}

/** 统一入口:解析 env 配置并实例化 provider。 */
export function resolveProviderFromEnv(model: string): LLMProvider {
  const { api, ...opts } = resolveProviderEnv(model);
  return resolveProvider(api, opts);
}
