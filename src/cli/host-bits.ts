/**
 * CLI host bits — host 侧具体实现,喂给 core 的注入接缝:
 *   - makeSpawnSyncHookRunner:settings-hook 的**同步**命令执行器(node:child_process.spawnSync)。
 *     约定:hook 进程 exit code 2 = block;stdout 若是 JSON {decision,reason,modify} 亦解析。
 *   - makeHttpSearchBackend:web_search 后端 —— POST {query} 到一个 HTTP 端点拿结果。
 *   - makeAskUser:交互式权限回路(--yes 全允许;否则非交互一律 deny,fail-closed)。
 *
 * 这些是 cli→core 方向的 host 实现,core/src 机制层不依赖本文件(干净律不破)。
 * Boundary: 仅 core 相对 + node: 全局。
 */
import { spawnSync } from 'node:child_process';
import type { CoreEvent } from '../events/types';
import type { HookDecision, HookCommandRunner } from '../capability/hooks/from-settings';
import { parseHookOutput, eventToHookInput } from '../capability/hooks/protocol';
import type { WebSearchBackend, WebSearchResult } from '../capability/builtin-tools/web-tools';
import type { AskUserFn } from '../agent/dispatch';
import { FORGEAX_USER_AGENT } from '../provider/user-agent';

/** 默认 hook 命令超时(ms),60s;可经 `FORGEAX_HOOK_TIMEOUT_MS` 覆写(>0)。 */
function hookTimeoutMs(): number {
  const raw = Number(process.env.FORGEAX_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * 用 node:child_process.spawnSync 同步跑 hook 命令。**全量** hook 协议:
 *  - stdin = wire JSON(eventToHookInput);
 *  - stdout JSON 经 `parseHookOutput` 解析:`decision/block` · `continue`(=false 停轮) ·
 *    `systemMessage` · `hookSpecificOutput.additionalContext` · `permissionDecision`(allow/deny/ask);
 *  - 额外支持 forgeax 扩展键 `modify`(对事件做 shallow patch,wire 协议之外);
 *  - exit code 2 = block(reason 取 stderr);
 *  - **超时 / 非 JSON / 空输出 → fail-open 放行**(坏 hook 不毒化总线)。
 */
export function makeSpawnSyncHookRunner(): HookCommandRunner {
  return (command: string, event: CoreEvent): HookDecision | void => {
    const wireInput = JSON.stringify(eventToHookInput(event));
    // node:child_process.spawnSync —— Node 与 Bun 同款语义(Bun 实现 node: 接口),
    // 单代码路径双运行时。spawn 失败 / 超时不抛,落到 res.error → fail-open。
    const res = spawnSync('sh', ['-c', command], {
      env: { ...process.env, FORGEAX_HOOK_EVENT: JSON.stringify(event) },
      input: wireInput,
      encoding: 'utf8',
      timeout: hookTimeoutMs(),
    });
    // spawn 失败 / 超时(Node 置 res.error，不抛)→ fail-open(不阻塞总线)。
    if (res.error) return;
    // 超时杀进程:status 为 null 且带 signal → fail-open。
    if (res.status == null && res.signal != null) return;

    const stdout = (res.stdout ?? '').trim();
    const stderr = (res.stderr ?? '').trim();

    // stdout JSON 决议(advanced hook output)经全量解析器。
    const decision: HookDecision = parseHookOutput(stdout);
    // forgeax 扩展:`modify`(wire 协议之外的 shallow patch)单独取。
    if (stdout.startsWith('{')) {
      try {
        const j = JSON.parse(stdout) as { modify?: Partial<CoreEvent> };
        if (j.modify && typeof j.modify === 'object') decision.modify = j.modify;
      } catch {
        /* parseHookOutput 已 fail-open;此处忽略 */
      }
    }
    // exit code 2 = block,reason 取 stderr(stdout 未显式 block 时)。
    if (res.status === 2 && !decision.block) {
      decision.block = true;
      if (decision.reason == null) decision.reason = stderr || `hook blocked (exit 2)`;
    }
    // 全空决议 → 放行(返回 void 与 {} 等价,但 void 更省)。
    return Object.keys(decision).length > 0 ? decision : undefined;
  };
}

/** web_search 后端:POST {query} 到 url,期望返回 `{results:[{title,url,snippet}]}` 或裸数组。 */
export function makeHttpSearchBackend(url: string): WebSearchBackend {
  return async (query: string, signal?: AbortSignal): Promise<WebSearchResult[]> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': FORGEAX_USER_AGENT },
      body: JSON.stringify({ query }),
      signal,
    });
    if (!res.ok) throw new Error(`search backend ${res.status}`);
    const data = (await res.json()) as { results?: WebSearchResult[] } | WebSearchResult[];
    return Array.isArray(data) ? data : (data.results ?? []);
  };
}

/**
 * Brave Search API 后端(开箱参考实现,单 key 即用)。
 * GET api.search.brave.com/res/v1/web/search?q=…,`X-Subscription-Token` 鉴权。
 */
export function makeBraveSearchBackend(apiKey: string): WebSearchBackend {
  return async (query: string, signal?: AbortSignal): Promise<WebSearchResult[]> => {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': FORGEAX_USER_AGENT,
        'x-subscription-token': apiKey,
      },
      signal,
    });
    if (!res.ok) throw new Error(`brave search ${res.status}`);
    const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description,
    }));
  };
}

/**
 * 从 env 解析默认 web_search 后端(`--search-url` flag 不给时的兜底):
 *   1. `FORGEAX_SEARCH_URL` → 通用 HTTP `POST {query}` 后端(与 flag 同实现);
 *   2. `BRAVE_API_KEY` / `BRAVE_SEARCH_API_KEY` → Brave Search 参考后端;
 *   3. 都无 → `undefined`(web_search 不进工具清单,裸跑保持干净)。
 */
export function makeDefaultSearchBackend(
  env: Record<string, string | undefined> = process.env,
): WebSearchBackend | undefined {
  const url = env.FORGEAX_SEARCH_URL?.trim();
  if (url) return makeHttpSearchBackend(url);
  const braveKey = (env.BRAVE_API_KEY ?? env.BRAVE_SEARCH_API_KEY)?.trim();
  if (braveKey) return makeBraveSearchBackend(braveKey);
  return undefined;
}

/** 交互式权限:approveAll(--yes)→ 全放行;否则非交互一律 deny(fail-closed)。 */
export function makeAskUser(approveAll: boolean): AskUserFn {
  return async () => approveAll;
}
