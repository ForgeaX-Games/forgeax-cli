// ClaudeCodeProvider — spawns the Anthropic claude-code CLI per chat turn,
// translates its stream-json ndjson into ChatEvent, and surfaces it through
// the CliProvider interface. See docs/CLI-PROVIDERS-DESIGN.md §Phase 2.
//
// The cli binary is named `claude` (not `claude-code`) since v2.x. Resolution
// order: ProviderConfig.options.binary → ANTHROPIC_CLI_PATH env →
// `which claude` → fall back to literal "claude" and let spawn fail loudly.
//
// Per-turn lifecycle (chat()):
//   1. spawn `claude -p --output-format=stream-json --include-partial-messages
//      --verbose <message>` with ANTHROPIC_API_KEY injected
//   2. drain stdout ndjson through claude-code-mapper
//   3. yield each ChatEvent tagged with providerId:"claude-code"
//   4. on AbortSignal: SIGTERM → SIGKILL (handled by spawnJsonl)
//   5. on non-zero exit without a "done": yield error with stderr tail

import type {
  CliProvider,
  ChatEvent,
  ChatRequest,
  ProviderCapabilities,
  ProviderConfig,
  ProviderHealth,
} from '../types';
import { spawnJsonl } from '../shared/subprocess-jsonl';
// friendlyPath 已被搬到 api/lib/（commit 64078a4 cleanup）; cli-providers 复活时
// 直接 reuse 那一份，不再维护 cli-providers/shared/friendly-path.ts。
import { friendlyPath } from '@forgeax/platform-io';
import { resolveBinary } from '../shared/resolve-binary';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getActiveGame } from '../../api/lib/active-game';
import { getSessionManager } from '../../core/session-manager';
import { existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { composeSystemPrompt } from '../../agents/loader';
import { buildGameCharter, buildActiveGameNote } from '../../agents/game-charter';

// Derived from env so the system prompt's URLs match the live ports. run.sh
// honors both FORGEAX_SERVER_PORT (default 18900) + FORGEAX_INTERFACE_PORT
// (default 18920); claude was previously told to hit hardcoded :18900/:18920
// even if studio booted with overrides. Read at module load — server process
// is restarted on env change. Tick cc-game/31.
const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';
const INTERFACE_PORT = process.env.FORGEAX_INTERFACE_PORT ?? '18920';

// System prompt appended to every claude-code turn so claude knows the
// forgeax-studio convention. The contract body now lives in the shared SSOT
// (../../agents/game-charter) so the native-agent slot path can't drift from
// it. Without this, "zuo ge tan chi she" writes a standalone HTML to $HOME and
// the studio Preview iframe can't see it. Tick cc-game/2.
const FORGEAX_SYSTEM_PROMPT = buildGameCharter({
  serverPort: SERVER_PORT,
  interfacePort: INTERFACE_PORT,
});

/**
 * Build the final --append-system-prompt arg. When the studio has a current
 * active game (most-recent .forgeax/games/<slug>/), claude is told to scope
 * ambiguous edits ("把背景改成蓝色") to that slug; otherwise base prompt only.
 * Pure function — exported for testability (tick cc-game/16).
 */
/** Best-effort: the game slug a chat tab's session is bound to, or undefined.
 *  Peek-only (never hydrates a session); ignores the 'default' sentinel and any
 *  slug whose .forgeax/games/<slug>/ dir no longer exists, so callers fall back
 *  to the workspace-level active game. */
function sessionDefaultDir(sid: string | undefined): string | undefined {
  if (!sid) return undefined;
  try {
    const slug = getSessionManager().peek(sid)?.config.defaultDir;
    if (!slug || slug === 'default') return undefined;
    const dir = resolvePath(defaultProjectRoot(), '.forgeax/games', slug);
    return existsSync(dir) ? slug : undefined;
  } catch {
    return undefined;
  }
}

export function buildSystemPrompt(activeSlug?: string): string {
  const note = buildActiveGameNote(activeSlug);
  return note ? `${FORGEAX_SYSTEM_PROMPT}\n\n${note}` : FORGEAX_SYSTEM_PROMPT;
}

/** Is there already an on-disk session file for this thread under `cwd`?
 *  We decide whether to resume an existing session or start a fresh one off the
 *  file on disk (not just the in-memory startedThreadIds set), so a server
 *  restart / thread re-hydrate can't desync and crash the next turn by trying
 *  to create a session id that already exists. Best-effort: any error → false,
 *  caller falls back to the in-memory path. */
function ccSessionExists(cwd: string, tid: string): boolean {
  try {
    const encoded = cwd.replace(/[/.]/g, '-');
    return existsSync(resolvePath(homedir(), '.claude', 'projects', encoded, `${tid}.jsonl`));
  } catch {
    return false;
  }
}
import {
  createClaudeMapperState,
  flushClaudeMapper,
  mapClaudeEvent,
  type ClaudeRawEvent,
} from '../shared/claude-code-mapper';
import { createCallTracker, withCallLifecycle } from '../shared/call-lifecycle';

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  subAgents: false,
  sessions: false,
  jsonlReplay: false,
};

const DEFAULT_BINARY = 'claude';

export class ClaudeCodeProvider implements CliProvider {
  readonly id = 'claude-code' as const;
  readonly displayName = 'the reference agent CLI';
  readonly capabilities = CAPABILITIES;

  private binary = DEFAULT_BINARY;
  private envOverride: Record<string, string> = {};

  /**
   * threadIds we've already started a claude-code session for. First call for
   * a given thread uses `--session-id <threadId>` (creates the session file in
   * ~/.claude/projects/.../<threadId>.jsonl); every subsequent call uses
   * `--resume <threadId>` so the conversation continues.
   *
   * In-memory only — server restart loses the set, but `--resume` keeps
   * working as long as the file on disk exists. A first turn after restart
   * for a known threadId would try `--session-id` and fail with "already in
   * use"; resumeFallbackOnceLoop below catches that and retries with
   * `--resume`, so restart resilience comes for free.
   */
  private startedThreadIds = new Set<string>();
  private readonly tracker = createCallTracker();

  /** Doc 05 section 7 -- abort an in-flight chat by callId. Idempotent for
   *  unknown / already-finished ids. */
  async cancel(callId: string): Promise<void> {
    await this.tracker.cancel(callId);
  }

  async init(cfg: ProviderConfig): Promise<void> {
    const configuredBin = (cfg.options?.binary as string | undefined) ?? undefined;
    this.binary = await resolveBinary({
      configured: configuredBin,
      envVarName: 'ANTHROPIC_CLI_PATH',
      defaultBinary: DEFAULT_BINARY,
    });
    if (cfg.env) this.envOverride = cfg.env;
  }

  async shutdown(): Promise<void> {
    // No long-lived state — each chat() spawns a fresh subprocess.
  }

  async health(timeoutMs = 1500): Promise<ProviderHealth> {
    // Check (a) binary executes (b) an auth credential is present somewhere.
    // Both checks run regardless of either's outcome so missing-binary +
    // missing-key are reported together rather than serially.
    //
    // Credential can arrive two ways: ANTHROPIC_API_KEY (x-api-key, e.g. a
    // litellm proxy key) OR ANTHROPIC_AUTH_TOKEN (Bearer, the OpenRouter
    // default path — there ANTHROPIC_API_KEY is intentionally blanked). Accept
    // either, else the OpenRouter setup is wrongly reported unhealthy and chat
    // is refused.
    const apiKey =
      this.envOverride.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ??
      this.envOverride.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
    // Redact $HOME prefix via shared friendlyPath helper (see shared/).
    const friendlyBin = friendlyPath(this.binary);
    let binaryDetail: string | null = null;
    let binaryOk = false;
    try {
      const proc = Bun.spawn({
        cmd: [this.binary, '--version'],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
      const out = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      clearTimeout(t);
      // Take first line only — a future `claude --version` that prints a
      // banner + version line would otherwise inject a newline into the
      // health detail string and break the cli-selector / Settings layout.
      const firstLine = out.split('\n', 1)[0]?.trim() ?? out;
      if (code === 0 && firstLine) { binaryOk = true; binaryDetail = `${friendlyBin} → ${firstLine}`; }
      else if (code === 0) binaryDetail = `${friendlyBin} ran but printed no --version output`;
      else binaryDetail = `binary ${friendlyBin} exited ${code}`;
    } catch (e) {
      binaryDetail = `cannot exec ${friendlyBin}: ${(e as Error).message}`;
    }
    const missing: string[] = [];
    if (!binaryOk) missing.push(binaryDetail!);
    if (!apiKey) missing.push('no API credential (set ANTHROPIC_AUTH_TOKEN for OpenRouter, ANTHROPIC_API_KEY, or OAuth via keychain)');
    if (missing.length === 0) return { ok: true, detail: binaryDetail ?? undefined };
    return { ok: false, detail: missing.join(' · ') };
  }

  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return withCallLifecycle(req, signal, this.tracker, (h) => this.runChat(req, h.signal));
  }

  private async *runChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    // Pre-flight: fail fast if missing key/binary so we surface a structured
    // error event rather than a confusing "subprocess exited 1".
    const h = await this.health(1000);
    if (!h.ok) {
      yield { type: 'error', message: h.detail ?? 'claude-code provider unhealthy', providerId: this.id };
      return;
    }

    const env: Record<string, string> = {};
    if (this.envOverride.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = this.envOverride.ANTHROPIC_API_KEY;
    if (this.envOverride.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = this.envOverride.ANTHROPIC_AUTH_TOKEN;
    if (this.envOverride.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = this.envOverride.ANTHROPIC_BASE_URL;
    // Spawn inherits process.env (subprocess-jsonl merges {...process.env,...env}),
    // so the actual OpenRouter creds flow through from $ROOT/.env even when
    // envOverride is empty. These explicit lines only matter if a route ever
    // populates cfg.env.

    const projectRoot = defaultProjectRoot();
    // Scope precedence for "the game": the chat tab's own session defaultDir
    // first (so two tabs bound to different games each scope to their own),
    // then the workspace-level active game (explicit active-game.json binding,
    // mtime fallback). Without the per-session step every claude tab scoped to
    // the single workspace-global active game regardless of which game that
    // tab was actually opened on. Session lookup is best-effort + peek-only
    // (never hydrates) so a missing/closed session just falls through.
    const scopeSlug = sessionDefaultDir(req.sessionId ?? req.threadId) ?? getActiveGame(projectRoot);
    let systemPrompt = buildSystemPrompt(scopeSlug);
    // Persona injection: req.agentId carries the marketplace agent id
    // (kotone / arin / yevi / …). composeSystemPrompt reads the plugin's
    // personaFile and concatenates default skill prompts. Append after the
    // FORGEAX scaffold prompt so the persona's voice/role overrides default
    // behavior while the studio conventions still apply.
    try {
      const personaId = req.agentId?.trim();
      if (personaId && personaId !== 'default' && personaId !== 'root') {
        const composed = await composeSystemPrompt(personaId);
        if (composed && composed.text.trim()) {
          systemPrompt = `${systemPrompt}\n\n---\n\n## Persona\n\n${composed.text.trim()}`;
        }
      }
    } catch (e) {
      console.warn(`[claude-code] persona compose failed for ${req.agentId}: ${(e as Error).message}`);
    }

    // Session continuity: tie the claude-code conversation to the chat tab's
    // threadId so multi-turn context is preserved. First call for a thread →
    // `--session-id` (creates the .jsonl on disk under threadId); subsequent
    // calls → `--resume`. Without this every turn spawned a fresh session
    // and the LLM saw only the current message.
    const sessionArgs: string[] = [];
    const tid = req.threadId?.trim();
    if (tid && /^[0-9a-f-]{36}$/i.test(tid)) {
      // Resume if we've started this thread in-process OR a session file is
      // already on disk. The disk check is what makes this restart-safe: after
      // a server restart the in-memory set is empty but the session file still
      // exists, and starting a fresh session on an existing id crashes the
      // turn. Either signal → resume.
      if (this.startedThreadIds.has(tid) || ccSessionExists(projectRoot, tid)) {
        sessionArgs.push('--resume', tid);
        this.startedThreadIds.add(tid);
      } else {
        sessionArgs.push('--session-id', tid);
        this.startedThreadIds.add(tid);
      }
    }

    // Permission approval loop: wire the CLI's permission-prompt tool to a
    // forgeax-provided MCP tool. Commands the CLI flags for approval are routed
    // to permission-server.mjs, which HTTP-calls back to /:sid/permission-request
    // → pops an approval card in the Studio UI → returns allow/deny so the
    // command executes or is blocked. Without this, a non-interactive spawn
    // auto-denies such commands with no way to approve. We can only route the
    // answer back if we have a thread/session id the UI is watching; skip
    // otherwise (acceptEdits still covers edits + plain commands).
    const permissionArgs: string[] = [];
    const permSid = (req.threadId?.trim() || req.sessionId?.trim() || '');
    if (permSid) {
      try {
        const serverPort = process.env.FORGEAX_SERVER_PORT ?? '18900';
        const mcpServerPath = resolvePath(import.meta.dir, '../mcp/permission-server.mjs');
        const mcpConfig = {
          mcpServers: {
            forgeax: {
              command: process.execPath, // the node/bun running the server — has fetch + stdio
              args: [mcpServerPath],
              env: {
                FORGEAX_SERVER_URL: `http://127.0.0.1:${serverPort}`,
                FORGEAX_SID: permSid,
                FORGEAX_AGENT: req.agentId?.trim() || 'forge',
              },
            },
          },
        };
        const cfgPath = resolvePath(tmpdir(), `forgeax-cc-mcp-${permSid}.json`);
        writeFileSync(cfgPath, JSON.stringify(mcpConfig));
        permissionArgs.push(
          '--mcp-config', cfgPath,
          '--permission-prompt-tool', 'mcp__forgeax__approve',
        );
      } catch (e) {
        console.warn(`[claude-code] permission-prompt wiring failed: ${(e as Error).message}`);
      }
    }

    // Model selection: the chat bridge resolves the per-agent choice
    // (agent.json::models.model, written by the ModelPicker) into
    // `req.options.model`. Honor it by passing `--model` to the claude CLI;
    // without this the CLI used its own built-in default (e.g. opus-4-7) and
    // the picker appeared to do nothing. Env vars are a headless fallback when
    // no per-agent pick exists.
    const selectedModel =
      (typeof req.options?.model === 'string' && req.options.model.trim()) ||
      process.env.ANTHROPIC_MODEL?.trim() ||
      process.env.FORGEAX_DEFAULT_MODEL?.trim() ||
      '';

    const args = [
      '-p',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
      // Set the permission mode explicitly instead of inheriting whatever the
      // operator's global CLI config defaults to — on a machine whose default
      // is restrictive, even file edits get denied and Forge can't write game
      // code at all. acceptEdits auto-approves file edits + plain Bash; commands
      // the CLI flags for approval still route to the permission-prompt tool
      // (above) when wired, so risky ops stay gated rather than silently denied.
      '--permission-mode', 'acceptEdits',
      // AskUserQuestion 不再屏蔽:它走同一套 permission-prompt 通道(CLI 对它请求
      // 审批),forgeax 弹「选项卡」让用户选,把所选答案回灌 → 模型拿到真实答案。
      // 见 permission-server.mjs 的 AskUserQuestion 分支 + interface PermissionPrompt。
      ...permissionArgs,
      ...(selectedModel ? ['--model', selectedModel] : []),
      ...sessionArgs,
      '--append-system-prompt', systemPrompt,
      req.message,
    ];

    // Short tag for the raw-ndjson debug dump below (FORGEAX_CC_RAW_DUMP).
    const traceTag = (req.threadId ?? req.sessionId ?? req.agentId ?? '?').slice(0, 8);

    const { lines, exit } = spawnJsonl<ClaudeRawEvent>({
      cmd: this.binary,
      args,
      env,
      // cwd = project root so Bash/Write default to forgeax-studio paths,
      // not the server's packages/server/ cwd where it'd never resolve
      // `.forgeax/games/...` correctly. Tick cc-game/2.
      cwd: projectRoot,
      signal,
    });

    const state = createClaudeMapperState();
    // Debug: dump every raw ndjson event from the subprocess to a file for
    // ground-truth inspection. Off by default; set FORGEAX_CC_RAW_DUMP=1 (→
    // /tmp/forgeax-cc-raw.ndjson) or to an absolute path. Server stdout is on
    // the user's tty (unreadable by tooling), so we append to a file.
    const rawDumpEnv = process.env.FORGEAX_CC_RAW_DUMP;
    const rawDumpPath = rawDumpEnv
      ? (rawDumpEnv === '1' ? '/tmp/forgeax-cc-raw.ndjson' : rawDumpEnv)
      : undefined;

    try {
      for await (const raw of lines) {
        if (rawDumpPath) {
          try { appendFileSync(rawDumpPath, `${traceTag} ${JSON.stringify(raw)}\n`); } catch { /* best-effort */ }
        }
        for (const ev of mapClaudeEvent(raw, state)) {
          (ev as ChatEvent).providerId = this.id;
          yield ev;
        }
      }
    } catch (streamErr) {
      yield {
        type: 'error',
        message: `claude-code stream error: ${(streamErr as Error).message}`,
        providerId: this.id,
      };
    }

    // Drain exit + surface non-zero exit if we never emitted a `done`.
    const exitInfo = await exit;
    if (!state.doneEmitted) {
      if (exitInfo.code !== 0) {
        const stderrTail = exitInfo.stderr.split('\n').slice(-3).join(' | ').trim();
        yield {
          type: 'error',
          message: `claude exited ${exitInfo.code}${stderrTail ? ': ' + stderrTail : ''}`,
          providerId: this.id,
        };
      } else {
        for (const ev of flushClaudeMapper(state)) {
          (ev as ChatEvent).providerId = this.id;
          yield ev;
        }
      }
    } else if (exitInfo.stderr.trim()) {
      // Happy path: result event already produced done. But the subprocess
      // wrote to stderr anyway (deprecation warnings, version hints, etc.).
      // Surface to server log so operators see it without surfacing in chat.
      const tail = exitInfo.stderr.split('\n').filter(Boolean).slice(-3).join(' | ');
      console.warn(`[claude-code] stderr (exit ${exitInfo.code}, done already emitted): ${tail}`);
    }
  }
}
