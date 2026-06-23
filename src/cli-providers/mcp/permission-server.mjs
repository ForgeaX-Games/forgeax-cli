#!/usr/bin/env node
/** forgeax permission-prompt MCP server (stdio).
 *
 *  Wired into the CLI spawn via `--mcp-config <cfg> --permission-prompt-tool
 *  mcp__forgeax__approve`. When the CLI needs permission for a tool call, it
 *  invokes this tool's `approve` with { tool_name, input }. We DON'T decide
 *  here — we HTTP-call back to the forgeax server (which pops an approval card
 *  in the Studio UI and blocks until the user clicks), then return the verdict:
 *      { behavior: 'allow', updatedInput }   |   { behavior: 'deny', message }
 *
 *  This is the responder a non-interactive spawn otherwise lacks. Config is
 *  passed via env so one script serves every thread:
 *    FORGEAX_SERVER_URL  e.g. http://127.0.0.1:18900
 *    FORGEAX_SID         the chat thread / session id (== WS sid the UI watches)
 *    FORGEAX_AGENT       agent path (for the card's attribution); optional
 *
 *  Plain Node + JSON-RPC-over-stdio (no SDK dep) so it runs under whatever node
 *  resolves on the operator's PATH. Fails CLOSED: any transport error → deny.
 */

import { appendFileSync } from 'node:fs';

const SERVER_URL = (process.env.FORGEAX_SERVER_URL || 'http://127.0.0.1:18900').replace(/\/$/, '');
const SID = process.env.FORGEAX_SID || '';
const AGENT = process.env.FORGEAX_AGENT || '';
const DEBUG = process.env.FORGEAX_CC_MCP_DEBUG;
const dbg = (m) => { if (DEBUG) { try { appendFileSync('/tmp/forgeax-cc-mcp.log', `${new Date().toISOString()} ${m}\n`); } catch {} } };

/** Human-readable one-liner for the approval card. */
function describe(toolName, input) {
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return input.command;
    if (typeof input.file_path === 'string') return `${toolName} ${input.file_path}`;
  }
  try { return `${toolName} ${JSON.stringify(input)}`.slice(0, 300); } catch { return toolName; }
}

/** Ask the forgeax UI (blocks until the user answers or the server times out).
 *  Returns { allow, answers? } — `answers` (keyed by question text) is present
 *  only for AskUserQuestion, so the caller can inject updatedInput.answers. */
async function askForgeax(toolName, input) {
  if (!SID) { dbg('no SID → deny'); return { allow: false }; }
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(SID)}/permission-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName, input, command: describe(toolName, input), agent: AGENT }),
    });
    if (!res.ok) { dbg(`request HTTP ${res.status} → deny`); return { allow: false }; }
    const j = await res.json();
    dbg(`decision allow=${j?.allow} answers=${j?.answers ? JSON.stringify(j.answers) : '-'}`);
    return { allow: j?.allow === true, answers: j?.answers };
  } catch (e) {
    dbg(`request error ${e?.message} → deny`);
    return { allow: false }; // fail closed
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { let m; try { m = JSON.parse(line); } catch { continue; } handle(m); }
  }
});

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'forgeax', version: '0.1.0' },
    } });
  } else if (method === 'notifications/initialized') {
    /* no response */
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'approve',
      description: 'forgeax permission prompt: routes a tool-permission request to the Studio UI for the user to approve or deny.',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, additionalProperties: true },
    }] } });
  } else if (method === 'tools/call') {
    const args = params?.arguments ?? {};
    const toolName = args.tool_name ?? 'tool';
    const input = args.input ?? {};
    dbg(`approve req tool=${toolName} ${describe(toolName, input)}`);
    const { allow, answers } = await askForgeax(toolName, input);
    let decision;
    if (!allow) {
      decision = { behavior: 'deny', message: '用户在 forgeax Studio 里拒绝了这个命令' };
    } else if (toolName === 'AskUserQuestion' && answers && typeof answers === 'object') {
      // Inject the user's picks so CC's AskUserQuestion.call gets real answers
      // (allow alone → "The user did not answer the questions"). P3.
      decision = { behavior: 'allow', updatedInput: { ...input, answers } };
    } else {
      decision = { behavior: 'allow', updatedInput: input };
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  } else if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}

dbg(`mcp permission server up · url=${SERVER_URL} sid=${SID}`);
