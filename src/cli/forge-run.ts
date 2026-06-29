/**
 * forge run — headless consumer of the forgeax chat wire (M9).
 *
 *   forge run [--json] "<message>" [options]
 *
 * A thin HTTP/SSE client: POSTs one turn to a RUNNING forgeax-server's
 * `/api/cli/chat` (the kernel-gated SSE path) and streams the wire events out.
 * It owns no orchestration — the server composes the turn, picks the kernel,
 * runs it, and translates KernelEvent → wire. This is the CLI/CI/上层-agent
 * face of the same wire the Web UI consumes (R1 §1: Web / CLI / SDK share one
 * wire). It does NOT touch the retired forgeax-cli daemon (packages/cli).
 *
 * Options:
 *   --json                 emit each wire event as one JSON line (JSONL) to stdout
 *                          (default: human text — assistant tokens streamed raw)
 *   --server <url>         server base url (default http://127.0.0.1:$FORGEAX_SERVER_PORT|18900)
 *   --agent <id>           target agent (default "default")
 *   --thread <uuid>        conversation thread; pass the SAME id again to resume
 *   --session <sid>        forgeax session id — share a session with the Web UI
 *   --timeout <ms>         per-call deadline (server aborts + emits done/cancelled)
 *
 * Exit codes: 0 = turn done; 1 = wire `error` / non-2xx; 2 = transport error.
 *
 * Pattern mirrors `src/cli/pack-cli.ts` + `bin/forgeax-pack` (bun launcher →
 * exported run function). No daemon required beyond a running server.
 */

interface ParsedArgs {
  message: string;
  json: boolean;
  server: string;
  agent: string;
  threadId?: string;
  sessionId?: string;
  timeoutMs?: number;
}

function parse(argv: string[]): ParsedArgs {
  // Allow an optional leading `run` subcommand (`forge run …`).
  const rest = argv[0] === 'run' ? argv.slice(1) : argv.slice(0);
  const positional: string[] = [];
  let json = false;
  let server = `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? '18900'}`;
  let agent = 'default';
  let threadId: string | undefined;
  let sessionId: string | undefined;
  let timeoutMs: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    switch (a) {
      case '--json': json = true; break;
      case '--server': server = rest[++i] ?? server; break;
      case '--agent': agent = rest[++i] ?? agent; break;
      case '--thread': threadId = rest[++i]; break;
      case '--session': sessionId = rest[++i]; break;
      case '--timeout': { const n = Number(rest[++i]); if (Number.isFinite(n) && n > 0) timeoutMs = n; break; }
      default:
        if (a && !a.startsWith('-')) positional.push(a);
        break;
    }
  }
  return {
    message: positional.join(' ').trim(),
    json,
    server: server.replace(/\/$/, ''),
    agent,
    ...(threadId ? { threadId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

const USAGE = `forge run [--json] "<message>" [--server <url>] [--agent <id>] [--thread <uuid>] [--session <sid>] [--timeout <ms>]`;

/** Parse `event:`/`data:` SSE frames out of a streamed body. Yields {event,data}. */
async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    // SSE frames are separated by a blank line (\n\n).
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length) yield { event, data: dataLines.join('\n') };
    }
  }
}

export async function runForgeRun(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const args = parse(argv);
  if (!args.message) {
    process.stderr.write(`error: message required\n${USAGE}\n`);
    return 2;
  }

  const callId =
    (globalThis.crypto?.randomUUID?.() as string | undefined) ?? `forge-${Date.now()}`;
  const body = {
    message: args.message,
    agentId: args.agent,
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    callId,
  };

  let res: Response;
  try {
    res = await fetch(`${args.server}/api/cli/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    process.stderr.write(`transport error: ${(e as Error).message}\n(is the server running at ${args.server}?)\n`);
    return 2;
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    process.stderr.write(`server error ${res.status}: ${detail}\n`);
    return 1;
  }

  let exitCode = 0;
  for await (const { event, data } of readSSE(res.body)) {
    if (args.json) {
      // One JSON line per wire event: { event, ...payload }. CI/上层 agent 友好。
      let payload: unknown = data;
      try { payload = JSON.parse(data); } catch { /* keep raw string */ }
      process.stdout.write(JSON.stringify({ event, data: payload }) + '\n');
    } else {
      // Human mode: stream assistant text; surface tool calls + errors briefly.
      try {
        const p = JSON.parse(data) as Record<string, unknown>;
        if (event === 'token' && typeof p.text === 'string') process.stdout.write(p.text);
        else if (event === 'thinking' && typeof p.text === 'string') process.stderr.write(`\x1b[2m${p.text}\x1b[0m`);
        else if (event === 'tool-call') process.stderr.write(`\n\x1b[36m· ${String(p.name)}(${JSON.stringify(p.args ?? {})})\x1b[0m\n`);
        else if (event === 'error') process.stderr.write(`\n\x1b[31merror: ${String(p.message ?? data)}\x1b[0m\n`);
      } catch { /* non-JSON frame — ignore in human mode */ }
    }
    if (event === 'done') { process.stdout.write(args.json ? '' : '\n'); break; }
    if (event === 'error') { exitCode = 1; break; }
  }
  return exitCode;
}
