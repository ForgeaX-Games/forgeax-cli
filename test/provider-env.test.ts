/** resolveProviderEnv / resolveProviderFromEnv —— 中立 env 路由契约
 *  (bug-empty-response-2026-07-13 L5)。
 *
 *  根因回放:api 家族只能从模型名推断时,逻辑模型名(claude-fable-5)会被发给
 *  anthropic 直连端点——`ANTHROPIC_BASE_URL` 若指向 Azure Anthropic,模型名被
 *  当作 deployment name → 404 DeploymentNotFound。锁三条规则:
 *    (a) `FORGEAX_PROVIDER_API` 显式覆盖家族,压过模型名推断(claude-* 也走
 *        openai-compat),凭证随家族切到 OPENAI_*;
 *    (b) 无覆盖 → 按 pickApi(model) 分派,anthropic 家族取 ANTHROPIC_*;
 *    (c) 家族与凭证成对:openai-compat 绝不误拿 ANTHROPIC_* 的 key/baseUrl。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveProviderEnv, resolveProviderFromEnv, pickApi } from '../src/cli/provider-env';

const ENV_KEYS = ['FORGEAX_PROVIDER_API', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveProviderEnv', () => {
  test('FORGEAX_PROVIDER_API 覆盖家族,凭证随家族取 OPENAI_*(claude-* 也不落 anthropic 直连)', () => {
    process.env.FORGEAX_PROVIDER_API = 'openai-compat';
    process.env.OPENAI_API_KEY = 'sk-compat';
    process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-direct'; // 直连配置同时在场,显式覆盖仍须赢
    process.env.ANTHROPIC_BASE_URL = 'https://azure.example.com';
    const cfg = resolveProviderEnv('claude-fable-5');
    expect(cfg.api).toBe('openai-compat');
    expect(cfg.apiKey).toBe('sk-compat');
    expect(cfg.baseUrl).toBe('https://proxy.example.com/v1');
    expect(resolveProviderFromEnv('claude-fable-5').api).toBe('openai-compat');
  });

  test('无覆盖 → 按模型名推断,anthropic 家族取 ANTHROPIC_*', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-direct';
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    process.env.OPENAI_API_KEY = 'sk-compat'; // 在场但不该被 anthropic 家族误拿
    const claude = resolveProviderEnv('claude-fable-5');
    expect(claude.api).toBe('anthropic-messages');
    expect(claude.apiKey).toBe('sk-direct');
    const gpt = resolveProviderEnv('gpt-5');
    expect(gpt.api).toBe('openai-compat');
    expect(gpt.apiKey).toBe('sk-compat'); // openai-compat 家族取自己的 env 对
  });

  test('pickApi 家族分派', () => {
    expect(pickApi('claude-fable-5')).toBe('anthropic-messages');
    expect(pickApi('gpt-5')).toBe('openai-compat');
    expect(pickApi('gemini-3-pro')).toBe('gemini');
    expect(pickApi('deepseek-v4-pro')).toBe('deepseek-v4');
  });
});
