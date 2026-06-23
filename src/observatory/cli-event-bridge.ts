/** Bridge `cli-providers` ChatEvent stream → per-session `EventBus`.
 *
 *  Why: claude-code (and any future external CLI provider) yields
 *  ChatEvent through `/api/cli/chat` SSE only. The observatory wants
 *  to draw turn / tool / token timelines and replay them from the
 *  ledger — that requires the same events to land in
 *  `session.eventBus` so `_bindLedgerPersistence` writes them to
 *  `~/.forgeax/sessions/<sid>/agents/<agent>/events/events-*.jsonl`.
 *
 *  Lifecycle (one helper instance per `chat()` call):
 *    1. `start(model)` publishes `hook:turnStart`
 *    2. `forwardChatEvent(ev)` translates each ChatEvent (accumulating
 *       token text, batching `stream:tool_use` etc.) and publishes.
 *    3. `end(stopReason, durationMs?)` emits any pending assistant
 *       message text + `hook:turnEnd` and resolves.
 *
 *  We use `emitterId = agentPath` so per-agent ledger persistence
 *  routes correctly. Without an emitterId, `bindSystemEventLog`
 *  treats the events as session-broadcasts and writes them to
 *  `global-events.jsonl` instead (the wrong place for turn data).
 */

import type { Session } from '../core/session';
import type { ChatEvent } from '../cli-providers/types';
import type { FileActivityOp, FileActivityRecord } from '../ledger/file-activity-ledger';

/** Tools (across all cli providers we currently bridge — claude-code today,
 *  codex/gemini in the future) that mutate a single file. Mapped to the
 *  ledger's FileActivityOp so AgentsPanel renders a sensible op badge. */
const FILE_TOOL_OPS: Record<string, FileActivityOp> = {
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
};

/** Pull the absolute file path out of a Write/Edit/NotebookEdit/MultiEdit
 *  arg object. the reference agent CLI's tool spec mandates absolute paths for
 *  `file_path`, so we trust that and just defensive-check the shape. */
function extractToolFilePath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const candidate = a.file_path ?? a.notebook_path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export interface CliBridgeOptions {
  session: Session;
  /** agent-tree path inside the session (eg "forge", "iori/suzu"). */
  agentPath: string;
  /** Model name surfaced in `hook:turnStart`. */
  model: string;
}

export class CliEventBridge {
  private session: Session;
  private agentPath: string;
  private model: string;

  /** Accumulator for `token` events — claude-code-mapper streams text by
   *  small chunks; we collapse into one `hook:assistantMessage` at done. */
  private tokenBuffer = '';
  private startedAt = 0;
  private turnIndex = 0;

  constructor(opts: CliBridgeOptions) {
    this.session = opts.session;
    this.agentPath = opts.agentPath;
    this.model = opts.model;
  }

  start(): void {
    this.startedAt = Date.now();
    this.turnIndex++;
    this.session.eventBus.publish(
      {
        type: 'hook:turnStart',
        ts: this.startedAt,
        source: `agent:${this.agentPath}`,
        payload: { model: this.model, turn: this.turnIndex },
      },
      this.agentPath,
    );
  }

  forward(ev: ChatEvent): void {
    switch (ev.type) {
      case 'token':
        this.tokenBuffer += ev.text;
        return;

      case 'thinking':
        this.session.eventBus.publish(
          {
            type: 'agent_log',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: { level: 'info', subtype: 'thinking', content: ev.text },
          },
          this.agentPath,
        );
        return;

      case 'tool-call':
        this.flushAssistantText();
        this.session.eventBus.publish(
          {
            type: 'stream:tool_use',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: { toolUseId: ev.callId, name: ev.name, input: ev.args },
          },
          this.agentPath,
        );
        this.recordFileActivity(ev.name, ev.args, ev.callId);
        return;

      case 'tool-result':
        this.session.eventBus.publish(
          {
            type: 'stream:tool_result',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: {
              toolUseId: ev.callId,
              output: ev.ok ? (ev.result ?? '') : (ev.error ?? ''),
              isError: !ev.ok,
            },
          },
          this.agentPath,
        );
        return;

      case 'error':
        this.session.eventBus.publish(
          {
            type: 'agent_log',
            ts: Date.now(),
            source: `agent:${this.agentPath}`,
            payload: { level: 'error', content: ev.message, code: ev.code },
          },
          this.agentPath,
        );
        return;

      // 'done' is handled via end(); 'stored-event' is forgeax-native
      // path only, already publishes through Session itself.
      case 'done':
      case 'stored-event':
        return;
    }
  }

  end(
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' = 'end_turn',
    durationMs?: number,
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): void {
    // Flush the accumulated assistant text *with* usage so the observatory
    // adapter's hook:assistantMessage → text branch can surface
    // `payload.usage` for the turn node. Without this the per-turn token
    // counts stay at 0 (the previous bridge dropped usage entirely).
    this.flushAssistantText(usage);
    const ts = Date.now();
    const elapsed = durationMs ?? (this.startedAt > 0 ? ts - this.startedAt : 0);
    this.session.eventBus.publish(
      {
        type: 'hook:turnEnd',
        ts,
        source: `agent:${this.agentPath}`,
        payload: {
          model: this.model,
          turn: this.turnIndex,
          stopReason,
          durationMs: elapsed,
          aborted: stopReason === 'cancelled',
          ...(usage ? { usage } : {}),
        },
      },
      this.agentPath,
    );
  }

  /** Bridge file-mutating tool calls into the per-session file-activity ledger.
   *  cli-provider agents (claude-code today) execute Write/Edit/NotebookEdit
   *  inside their own subprocess and never touch agentContext.fs, so the
   *  wrapAgentFsWithRecorder hook that normally feeds the ledger doesn't
   *  fire. Without this bridge AgentsPanel (which attributes files via the
   *  ledger when ?sid= is supplied) shows empty files[] for them. */
  private recordFileActivity(name: string, args: unknown, callId: string): void {
    const op = FILE_TOOL_OPS[name];
    if (!op) return;
    const path = extractToolFilePath(args);
    if (!path) return;
    const ts = Date.now();
    const record: FileActivityRecord = {
      ts,
      agentPath: this.agentPath,
      op,
      path,
      toolCallId: callId,
    };
    try {
      this.session.fileActivity.append(record);
    } catch {
      /* ledger write must never abort event forwarding */
    }
    // Publish file-activity:done so the WS bridge wakes up
    // useFileActivityVersion(sid) on the client and AgentsPanel refetches.
    // Shape mirrors session-manager.ts's recorder hook (the canonical emitter
    // for native fs writes) so a single dispatcher on the client handles both.
    this.session.eventBus.publish(
      {
        type: 'file-activity:done',
        ts,
        source: `agent:${this.agentPath}`,
        payload: record as unknown as Record<string, unknown>,
      },
      this.agentPath,
    );
  }

  private flushAssistantText(usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    const text = this.tokenBuffer;
    if (!text && !usage) return;
    this.tokenBuffer = '';
    this.session.eventBus.publish(
      {
        type: 'hook:assistantMessage',
        ts: Date.now(),
        source: `agent:${this.agentPath}`,
        payload: {
          msg: { content: text },
          ...(usage ? { usage } : {}),
        },
      },
      this.agentPath,
    );
  }
}
