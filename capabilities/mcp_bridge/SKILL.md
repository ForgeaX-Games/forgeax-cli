---
name: mcp-bridge
description: >-
  Bridge between forgeax-cli's capability/tool system and Anthropic-style MCP servers (Model Context Protocol). Spawns MCP servers as child processes, speaks JSON-RPC over stdio, exposes their tools to the agent under the canonical `mcp__<server>__<tool>` naming convention.
disable-model-invocation: false
---

# mcp-bridge — bring MCP servers into forgeax-cli

> Implements MISSION D10's "Playwright MCP develop-test-screenshot loop" and the user's request "整体 forgeax 的 mcp 跑通" (cli-port SPEC STEP 25 → B branch).

## What it does

For each entry in `<cli-root>/mcp.config.json` `mcpServers`, this capability spawns the MCP server child (e.g. `npx @playwright/mcp@latest`), connects via JSON-RPC 2.0 over stdio, then exposes that server's tools as native ToolDefinitions named `mcp__<server>__<tool>`.

Tools currently shipped (Playwright-specific, the most-used set):

- `mcp__playwright__browser_navigate` — open a URL in the headless browser
- `mcp__playwright__browser_take_screenshot` — capture viewport / element / full-page PNG
- `mcp__playwright__browser_snapshot` — accessibility tree (token-cheap alternative to screenshot)

Additional Playwright tools (`browser_click`, `browser_console_messages`, `browser_press_key`, ...) follow the same pattern and are easy to add as siblings.

## Configuration

`<cli-root>/mcp.config.json` (auto-loaded by `lib/mcp-client.ts`):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

## Wire protocol

JSON-RPC 2.0 over stdin/stdout, line-delimited. Initialization handshake:

1. Send `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"forgeax-cli","version":"1.2.0-forgeax.1"},"capabilities":{}}}`
2. Receive server's capabilities + tools list
3. Send `{"jsonrpc":"2.0","method":"notifications/initialized"}`
4. Tool calls: `{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}`

The lib lazily spawns each server on first use, multiplexes responses by id, persists across calls.

## D10 develop-test-screenshot loop (canonical sequence)

In one agent turn the agent should:

1. `write_file games/<id>/src/main.ts` (built-in) — make the change
2. `mcp__playwright__browser_navigate http://localhost:15173/packages/engine/?game=<id>` — open preview
3. `mcp__playwright__browser_snapshot` — verify accessibility tree (cheap)
4. If visual confirmation needed: `mcp__playwright__browser_take_screenshot` — capture PNG
5. Compare to user intent → done OR iterate

## Caveats / known limits

- **Browser install**: first call may take ~30s while Playwright downloads chromium.
- **Network required** at first call (npx + binary download).
- **Lifecycle**: child server stays alive until cli daemon dies; heavyweight, single-shot per forgeax session is the expected pattern.
- **End-to-end validation** is gated on cli-port STEP 22's open follow-up F-VIBE-1 (forgeax team manifest). Once an agent can actually run a turn against this cli build, this capability becomes hot.

## Files

```
mcp_bridge/
├── SKILL.md                                  this file
├── lib/mcp-client.ts                          stdio JSON-RPC client + server lifecycle
└── tools/
    ├── mcp_playwright_navigate.ts             ToolDefinition mcp__playwright__browser_navigate
    ├── mcp_playwright_take_screenshot.ts      ToolDefinition mcp__playwright__browser_take_screenshot
    └── mcp_playwright_snapshot.ts             ToolDefinition mcp__playwright__browser_snapshot
```
