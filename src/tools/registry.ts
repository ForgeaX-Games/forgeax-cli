/**
 * Phase D1 — ToolRegistry: dispatcher for `host.tool.call(toolId, args)`.
 *
 * Sits next to PluginSnapshot (single direction: ToolRegistry reads the
 * snapshot's `kinds.tools[]` to discover handlers; PluginSnapshot does not
 * know about ToolRegistry). The split keeps reload semantics simple: any
 * POST /api/plugins/reload bumps the snapshot, ToolRegistry picks up the
 * new handler list on next call() — no eager re-import needed because
 * handler modules are loaded lazily.
 *
 * Resolution order on call(toolId):
 *   1. Look up ToolEntry by toolId in the current snapshot.
 *   2. If entry.backendPath is null → 501 (manifest declares schema only,
 *      no handler shipped — D6 authoring path will fill these later).
 *   3. Dynamic-import entry.backendPath. Module must export an object
 *      mapping toolId → handler (default export OR named `tools`).
 *   4. Cache the resolved handler module by backendPath so repeated calls
 *      don't re-import.
 *
 * Permission gating: callers from the AI side (`caller.kind='ai'`) require
 * `entry.exposedToAI === true`. Other caller kinds (user/skill/workbench/cli)
 * are allowed for any registered tool — finer-grained permission lands in
 * Phase D6 (trust-decision panel) when the trust model is wired.
 */
import { getPluginSnapshot } from '../plugins/registry';
import type { ToolEntry } from '../plugins/kinds';
import type { ToolCall, ToolResult, ImageGen } from '@forgeax/types';
import { getEventBus } from '../events/bus';
import { isPaused } from '../runtime/pause';
import { createImageGen } from '../lib/image-gateway/create-image-gen';
import { defaultProjectRoot } from '@forgeax/platform-io';

export type ToolHandler = (
  args: unknown,
  ctx: {
    caller: ToolCall['caller'];
    toolId: string;
    /** GAP 5 — env keys allow-listed by the plugin's manifest `requestedEnv`.
     *  Handlers MUST NOT touch `process.env` directly; this is the only
     *  channel for host secrets. */
    env: Record<string, string | undefined>;
    /** Absolute path to the plugin's directory (where forgeax-plugin.json
     *  lives). Use this instead of `process.cwd()` for sibling-file reads. */
    cwd: string;
    /** 用户数据根(`<projectRoot>/.forgeax/games/...` 所在);写用户工程数据的
     *  插件 handler 用此,而非 cwd(=插件安装目录)。宿主从 path-manager 注入。 */
    projectRoot: string;
    /** 宿主下注的图像生成能力(中立 @forgeax/types ImageGen 缝)。图像类插件
     *  handler 经此生图,不必反向 import 编排层的 vendor 实现。懒构造,非图像
     *  工具 0 成本。 */
    imageGen: ImageGen;
  },
) => Promise<unknown> | unknown;

type HandlerModule = Record<string, ToolHandler>;

const moduleCache = new Map<string, HandlerModule>();

// Per-snapshot toolId → ToolEntry index. Built lazily on first lookup and
// auto-evicted when the plugin snapshot is rebuilt (POST /api/plugins/reload),
// since the WeakMap key is the snapshot object itself. Replaces the linear
// scan that ran on every tool dispatch — including hot AI-streaming paths.
const _toolIndex = new WeakMap<object, Map<string, ToolEntry>>();

function findEntry(toolId: string): ToolEntry | null {
  const snap = getPluginSnapshot();
  let idx = _toolIndex.get(snap);
  if (!idx) {
    idx = new Map();
    for (const t of snap.kinds.tools) idx.set(t.toolId, t);
    _toolIndex.set(snap, idx);
  }
  return idx.get(toolId) ?? null;
}

async function loadHandlerModule(backendPath: string): Promise<HandlerModule | null> {
  const cached = moduleCache.get(backendPath);
  if (cached) return cached;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(backendPath)) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Accept default export, `tools` named export, or the whole module
  // namespace. Whatever shape ships, we treat it as Record<id,fn>.
  const candidate =
    (mod.default && typeof mod.default === 'object' ? mod.default : null) ??
    (mod.tools && typeof mod.tools === 'object' ? mod.tools : null) ??
    mod;
  const out: HandlerModule = {};
  for (const [k, v] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof v === 'function') out[k] = v as ToolHandler;
  }
  moduleCache.set(backendPath, out);
  return out;
}

export interface ToolDispatchError {
  ok: false;
  error: string;
  code:
    | 'not_found'
    | 'no_handler'
    | 'forbidden'
    | 'load_error'
    | 'invoke_error'
    | 'confirm-timeout'
    | 'user-rejected'
    | 'confirm-emit-failed'
    | 'paused';
}

/* ----------------------------------------------------------------------------
 * 07 §9.5 — runtime confirm gate.
 *
 * For AI callers, a tool that declares requireConfirm in {'always','destructive'}
 * blocks inside ToolRegistry until the host receives an ack via the event bus.
 * Decision flow:
 *
 *   call() -> emit tool.confirm-required { token, ... } -> wait
 *          -> host UI -> emit tool.confirm-acked { token, decision }
 *          -> timeout (default 30s) -> confirm-timeout
 *
 * token = confirm-${toolId}-${epoch}-${random6}; filters on it before resolving.
 * User-driven callers (caller.kind='user'|'workbench'|'cli'|'skill') bypass
 * this gate — only caller.kind='ai' is gated (C-3).
 * --------------------------------------------------------------------------*/

const CONFIRM_TIMEOUT_MS = Number(process.env.FORGEAX_TOOL_CONFIRM_TIMEOUT_MS ?? 30_000);

interface ConfirmAckPayload {
  token: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

async function awaitConfirm(
  entry: ToolEntry,
  req: ToolCall,
): Promise<{ ok: true } | { ok: false; code: 'confirm-timeout' | 'user-rejected' | 'confirm-emit-failed'; error: string }> {
  const bus = getEventBus();
  const timeoutMs = Number(process.env.FORGEAX_TOOL_CONFIRM_TIMEOUT_MS ?? CONFIRM_TIMEOUT_MS);
  const epoch = Date.now();
  const random6 = Math.random().toString(36).slice(2, 8);
  const token = `confirm-${req.toolId}-${epoch}-${random6}`;
  const expiresAt = epoch + timeoutMs;
  // D-5: catch synchronous throws from bus.emit (e.g. overloaded or torn-down bus)
  try {
    bus.emit(
      'tool.confirm-required',
      {
        token,
        toolId: req.toolId,
        args: req.args,
        caller: req.caller,
        message: entry.confirmMessage ?? null,
        expiresAt,
      },
      { threadId: req.caller.threadId },
    );
  } catch (emitErr) {
    return {
      ok: false,
      code: 'confirm-emit-failed',
      error: `tool.confirm-required emit failed for ${req.toolId}: ${(emitErr as Error).message ?? String(emitErr)}`,
    };
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingConfirms.delete(token);
      unsub();
      resolve({
        ok: false,
        code: 'confirm-timeout',
        error: `confirm not received in ${timeoutMs}ms for tool ${req.toolId}`,
      });
    }, timeoutMs);
    pendingConfirms.set(token, { resolve: resolve as (v: unknown) => void, timer });
    const unsub = bus.subscribe('tool.confirm-acked', (env) => {
      const p = env.payload as ConfirmAckPayload | null;
      if (!p || typeof p !== 'object' || p.token !== token) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingConfirms.delete(token);
      unsub();
      if (p.decision === 'allow') resolve({ ok: true });
      else
        resolve({
          ok: false,
          code: 'user-rejected',
          error: `tool ${req.toolId} denied by user${p.reason ? `: ${p.reason}` : ''}`,
        });
    });
  });
}

/** Module-scope pending confirms map (D-3). Exposed for test resets. */
export const pendingConfirms = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

export function _resetConfirmsForTests(): void {
  for (const { timer } of pendingConfirms.values()) clearTimeout(timer);
  pendingConfirms.clear();
}

export async function callTool(req: ToolCall): Promise<ToolResult> {
  const bus = getEventBus();
  const threadId = req.caller.threadId;
  // Doc 07 §TopBar Pause — when AI-actor is paused, short-circuit before
  // hitting the handler. Skill-initiated calls also count as AI when the
  // skill was kicked off by an AI turn (caller.kind='ai' propagates).
  if (req.caller.kind === 'ai' && isPaused()) {
    const r: ToolResult = {
      ok: false,
      error: `tool ${req.toolId} blocked: AI runtime is paused`,
      code: 'paused',
    };
    bus.emit('tool.failed', { toolId: req.toolId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  const entry = findEntry(req.toolId);
  if (!entry) {
    const r: ToolResult = { ok: false, error: `tool not found: ${req.toolId}`, code: 'not_found' };
    bus.emit('tool.failed', { toolId: req.toolId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  if (req.caller.kind === 'ai' && !entry.exposedToAI) {
    const r: ToolResult = {
      ok: false,
      error: `tool ${req.toolId} is not exposedToAI`,
      code: 'forbidden',
    };
    bus.emit('tool.failed', { toolId: req.toolId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  if (!entry.backendPath) {
    const r: ToolResult = {
      ok: false,
      error: `tool ${req.toolId} has no backend handler (manifest schema-only)`,
      code: 'no_handler',
    };
    bus.emit('tool.failed', { toolId: req.toolId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  if ((entry.requireConfirm === 'always' || entry.requireConfirm === 'destructive') && req.caller.kind === 'ai') {
    const verdict = await awaitConfirm(entry, req);
    if (!verdict.ok) {
      bus.emit('tool.failed', { toolId: req.toolId, error: verdict.error, caller: req.caller }, { threadId });
      return { ok: false, error: verdict.error, code: verdict.code };
    }
  }
  bus.emit('tool.starting', { toolId: req.toolId, args: req.args, caller: req.caller }, { threadId });
  const startedAt = Date.now();
  const mod = await loadHandlerModule(entry.backendPath);
  if (!mod) {
    const r: ToolResult = {
      ok: false,
      error: `failed to load handler module ${entry.backendPath}`,
      code: 'load_error',
    };
    bus.emit('tool.failed', { toolId: req.toolId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  const handler = mod[req.toolId];
  if (!handler) {
    const r: ToolResult = {
      ok: false,
      error: `module ${entry.backendPath} does not export handler for "${req.toolId}"`,
      code: 'no_handler',
    };
    bus.emit('tool.failed', { toolId: req.toolId, error: r.error, caller: req.caller }, { threadId });
    return r;
  }
  try {
    const filteredEnv: Record<string, string | undefined> = {};
    for (const k of entry.requestedEnv) filteredEnv[k] = process.env[k];
    const result = await handler(req.args, {
      caller: req.caller,
      toolId: req.toolId,
      env: filteredEnv,
      cwd: entry.pluginDir,
      projectRoot: defaultProjectRoot(),
      imageGen: createImageGen(filteredEnv),
    });
    bus.emit(
      'tool.completed',
      { toolId: req.toolId, durationMs: Date.now() - startedAt, caller: req.caller },
      { threadId },
    );
    return { ok: true, result };
  } catch (e) {
    const err = (e as Error).message ?? String(e);
    bus.emit('tool.failed', { toolId: req.toolId, error: err, caller: req.caller }, { threadId });
    return { ok: false, error: err, code: 'invoke_error' };
  }
}

/** Public listing for /api/tools/list. AI callers can check requireConfirm
 *  to know in advance which tools will block for human ack (charter P1). */
export interface ToolDescriptor {
  id: string;
  pluginId: string;
  description?: string;
  exposedToAI: boolean;
  /** Three-value enum: 'always' | 'destructive' | 'never' | undefined.
   *  Undefined means not set (same semantics as 'never'). */
  requireConfirm?: 'always' | 'destructive' | 'never';
  confirmMessage?: string;
  hasHandler: boolean;
  argsSchema?: unknown;
  returnsSchema?: unknown;
}

export function listTools(): ToolDescriptor[] {
  return getPluginSnapshot().kinds.tools.map((t) => ({
    id: t.toolId,
    pluginId: t.pluginId,
    description: t.description,
    exposedToAI: t.exposedToAI,
    requireConfirm: t.requireConfirm,
    confirmMessage: t.confirmMessage,
    hasHandler: !!t.backendPath,
    argsSchema: t.argsSchema,
    returnsSchema: t.returnsSchema,
  }));
}

/** Test helper — drop the per-backend module cache. */
export function _resetToolHandlerCacheForTests(): void {
  moduleCache.clear();
}
