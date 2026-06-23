// Minimal newline-delimited JSON-RPC 2.0 client over a persistent
// `codex app-server` subprocess. This is the transport the CodexProvider uses
// to get an interactive APPROVAL loop (codex `exec --json` has no approval
// callback channel — see docs in providers/codex.ts).
//
// Wire format (verified live, codex-cli 0.139): each message is a single JSON
// object on its own line. Three message shapes on stdout:
//   • response      { id, result } | { id, error }          — reply to our request
//   • serverRequest { id, method, params }                  — codex asks US (approvals!)
//   • notification  { method, params }  (no id)             — streaming events
// We write the same newline-JSON on stdin: requests { jsonrpc, id, method, params }
// and responses to serverRequests { jsonrpc, id, result }.
//
// One app-server process is shared per provider instance (lazy-spawned, reused
// across threads/turns). On crash/exit the client marks itself dead so the next
// ensureStarted() respawns. Unknown messages are tolerated (experimental proto).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type JsonRpcId = number | string;

/** A server→client request codex expects us to answer (approvals, elicitation). */
export interface ServerRequest {
  id: JsonRpcId;
  method: string;
  params: any;
}

/** Handler for a server→client request. Return the `result` object (becomes
 *  `{ id, result }`). Throw to reply with a JSON-RPC error. */
export type ServerRequestHandler = (req: ServerRequest) => Promise<unknown> | unknown;

/** Handler for a notification (no id). */
export type NotificationHandler = (method: string, params: any) => void;

export interface CodexAppServerOptions {
  /** Binary path (resolved by the provider). */
  binary: string;
  /** Working directory for the app-server process. */
  cwd: string;
  /** Extra env merged onto process.env (e.g. OPENAI_API_KEY/BASE_URL). */
  env?: Record<string, string>;
  /** Global codex args injected BEFORE the `app-server` subcommand (e.g. `-c`
   *  config overrides registering the forgeax-tools MCP server). */
  globalArgs?: string[];
  /** Routes server→client requests we don't otherwise handle. */
  onServerRequest: ServerRequestHandler;
  /** Receives every notification. */
  onNotification: NotificationHandler;
  /** Called when the subprocess exits (so the provider can fail in-flight turns). */
  onExit?: (code: number | null, stderrTail: string) => void;
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderrTail = '';
  private initialized = false;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: CodexAppServerOptions) {}

  get alive(): boolean {
    return this.proc != null && this.proc.exitCode == null && !this.proc.killed;
  }

  /** Lazily spawn `codex app-server` + run the `initialize` handshake once.
   *  Idempotent + concurrency-safe (a single in-flight start is shared). */
  async ensureStarted(): Promise<void> {
    if (this.alive && this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async _start(): Promise<void> {
    const proc = spawn(this.opts.binary, [...(this.opts.globalArgs ?? []), 'app-server'], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.initialized = false;
    this.buf = '';
    this.stderrTail = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this._onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    // Absorb EPIPE/ECONNRESET on the long-lived stdio streams so a dead
    // app-server can't bubble an unhandled stream 'error' into a process-wide
    // uncaughtException. The 'exit' handler below rejects pending requests and
    // notifies the provider; these listeners just stop the error escaping.
    proc.stdin.on('error', () => { /* EPIPE — app-server gone; exit handler handles it */ });
    proc.stdout.on('error', () => { /* swallow — exit handler handles it */ });
    proc.stderr.on('error', () => { /* swallow — exit handler handles it */ });
    proc.on('exit', (code) => {
      this.initialized = false;
      // Reject every in-flight request so callers don't hang forever.
      const err = new Error(`codex app-server exited (code=${code})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      try { this.opts.onExit?.(code, this.stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ')); } catch { /* ignore */ }
    });

    // Handshake. clientInfo shape verified: { name, title|null, version }.
    await this.request('initialize', {
      clientInfo: { name: 'forgeax', title: 'forgeax-studio', version: '0.1.0' },
      capabilities: null,
    });
    this.initialized = true;
  }

  private _onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; /* tolerate noise */ }
      this._dispatch(msg);
    }
  }

  private _dispatch(msg: any): void {
    // Response to one of our requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    // Server→client request (approvals etc.) — has BOTH id and method.
    if (msg.id != null && typeof msg.method === 'string') {
      void this._handleServerRequest(msg as ServerRequest);
      return;
    }
    // Notification (no id).
    if (typeof msg.method === 'string') {
      try { this.opts.onNotification(msg.method, msg.params); } catch { /* never let a handler break the read loop */ }
    }
  }

  private async _handleServerRequest(req: ServerRequest): Promise<void> {
    try {
      const result = await this.opts.onServerRequest(req);
      this._send({ jsonrpc: '2.0', id: req.id, result });
    } catch (e) {
      this._send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } });
    }
  }

  /** Send a request and await its response. Rejects if the process dies. */
  request(method: string, params: unknown): Promise<any> {
    if (!this.proc || this.proc.exitCode != null) {
      return Promise.reject(new Error('codex app-server not running'));
    }
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this._send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  /** Fire-and-forget notification to the server. */
  notify(method: string, params: unknown): void {
    this._send({ jsonrpc: '2.0', method, params });
  }

  private _send(obj: unknown): void {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* stdin closed — the exit handler will reject pending requests */
    }
  }

  /** Best-effort terminate. */
  shutdown(): void {
    try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
    this.proc = null;
    this.initialized = false;
  }
}
