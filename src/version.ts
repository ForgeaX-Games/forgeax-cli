/**
 * 版本 SSOT —— 机制层零依赖叶子,任何层都可相对 import。
 *
 * 权威真相 = package.json 的 `version`;这里只是派生读出(Derive, Don't Duplicate)。
 * 消费方:CLI `--version`、出站 User-Agent(provider/user-agent.ts)、MCP clientInfo
 * (capability/mcp/client.ts)、mcp-serve SERVER_INFO、TUI 欢迎横幅。
 *
 * Boundary: 仅相对 import(package.json;tsconfig 已开 resolveJsonModule,Bun 原生支持)。
 */
import pkg from '../package.json';

/** forgeax-core 版本号(SSOT = package.json)。 */
export const FORGEAX_CORE_VERSION: string = (pkg as { version: string }).version;
