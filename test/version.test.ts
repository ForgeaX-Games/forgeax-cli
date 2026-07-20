/**
 * 版本 SSOT 一致性(防手改回退):FORGEAX_CORE_VERSION 派生自 package.json,
 * 所有消费方(--version / User-Agent / MCP clientInfo / mcp-serve SERVER_INFO)
 * 都引同一常量,不再出现第二真相。
 */
import { test, expect, describe } from 'bun:test';
import { FORGEAX_CORE_VERSION } from '../src/version';
import { FORGEAX_USER_AGENT } from '../src/provider/user-agent';
import { DEFAULT_MCP_CLIENT_INFO } from '../src/capability/mcp/client';
import pkg from '../package.json';

describe('version SSOT', () => {
  test('FORGEAX_CORE_VERSION derives from package.json', () => {
    expect(FORGEAX_CORE_VERSION).toBe(pkg.version);
    expect(FORGEAX_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('outbound User-Agent carries the SSOT version', () => {
    expect(FORGEAX_USER_AGENT).toContain(`forgeax-cli/${pkg.version}`);
  });

  test('MCP clientInfo carries the SSOT version', () => {
    expect(DEFAULT_MCP_CLIENT_INFO.version).toBe(pkg.version);
  });
});
