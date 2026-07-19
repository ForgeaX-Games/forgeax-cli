/**
 * C-02 — web_search 默认后端 / 未配置不进工具清单。
 *
 * 断言装配产物:未注入 searchBackend 时 `web_search` **不出现在工具列表**里
 * (模型根本看不到不可用的工具),`web_fetch` 始终在;注入后端后 `web_search` 回归。
 * 全 hermetic(不打真 API)。
 */
import { test, expect, describe } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assembleCapabilities } from '../src/runtime/assemble';
import { webToolsPack } from '../src/capability/builtin-tools/web-tools';
import { makeHttpSearchBackend, makeDefaultSearchBackend } from '../src/cli/host-bits';
import type { ToolContext } from '../src/capability/types';
import { EventBus } from '../src/events/event-bus';

describe('C-02 web_search default backend', () => {
  test('未注入 searchBackend:web_search 不进工具清单,web_fetch 仍在', async () => {
    const assembled = await assembleCapabilities({ bus: new EventBus() });
    try {
      const names = assembled.tools.map((t) => t.name);
      expect(names).toContain('web_fetch');
      expect(names).not.toContain('web_search');
    } finally {
      for (const d of assembled.disposers) await d();
    }
  });

  test('注入 searchBackend:web_search 回归工具清单', async () => {
    const assembled = await assembleCapabilities({
      bus: new EventBus(),
      searchBackend: async () => [{ title: 't', url: 'https://x', snippet: 's' }],
    });
    try {
      const names = assembled.tools.map((t) => t.name);
      expect(names).toContain('web_fetch');
      expect(names).toContain('web_search');
    } finally {
      for (const d of assembled.disposers) await d();
    }
  });

  test('webToolsPack 直接调用:无后端只出 web_fetch,有后端两个都出', () => {
    const bare = webToolsPack().tools.map((t) => t.name);
    expect(bare).toContain('web_fetch');
    expect(bare).not.toContain('web_search');

    const withBackend = webToolsPack({ searchBackend: async () => [] }).tools.map((t) => t.name);
    expect(withBackend).toContain('web_fetch');
    expect(withBackend).toContain('web_search');
  });

  test('端到端(flag 路径):--search-url → web_search 走真 HTTP 往返返回结果', async () => {
    // 本地 mock 搜索端点,模拟 host 经 --search-url 注入的 HTTP 后端。
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { query } = JSON.parse(body) as { query: string };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ results: [{ title: `hit: ${query}`, url: 'https://ex/1', snippet: 'ok' }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const backend = makeHttpSearchBackend(url);
      const pack = webToolsPack({ searchBackend: backend });
      const search = pack.tools.find((t) => t.name === 'web_search')!;
      expect(search).toBeDefined();
      const out = (await search.call({ query: 'forgeax core' }, { signal: undefined } as unknown as ToolContext)) as {
        data: { results: Array<{ title: string; url: string }> };
      };
      expect(out.data.results).toHaveLength(1);
      expect(out.data.results[0].title).toBe('hit: forgeax core');
      expect(out.data.results[0].url).toBe('https://ex/1');
    } finally {
      server.close();
    }
  });

  test('默认后端 env 解析:FORGEAX_SEARCH_URL 命中,空 env → undefined', () => {
    expect(makeDefaultSearchBackend({})).toBeUndefined();
    expect(makeDefaultSearchBackend({ FORGEAX_SEARCH_URL: 'http://x' })).toBeInstanceOf(Function);
    expect(makeDefaultSearchBackend({ BRAVE_API_KEY: 'k' })).toBeInstanceOf(Function);
  });
});
