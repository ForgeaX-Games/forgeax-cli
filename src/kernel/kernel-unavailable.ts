/**
 * Kernel-unavailable diagnostics — turn a bare `kernel_unavailable: <id>` (or a
 * raw spawn/login failure) into a cause-aware, actionable message the end user
 * can act on, especially for third-party kernels that need an external CLI to be
 * installed and logged in.
 *
 * Two producers feed this:
 *   1. `resolveKernel` throws `KernelUnavailableError` when the requested/default
 *      kernel is not registered (reasons `unknown-id` / `not-registered`).
 *   2. A kernel's `runTurn` yields (or throws) a spawn/exit failure when its
 *      external CLI is missing or unauthenticated. The kernel's own `probe()` is
 *      the readiness authority; `classifyProbeDetail` maps its free-form detail
 *      into `not-installed` / `not-logged-in`.
 *
 * SSOT: chat's SSE error exit is the single translation point (see api/cli/chat.ts)
 * — `toKernelErrorPayload` is the only place that decides friendly vs raw. The
 * prose obeys the "no external brand codenames" rule: only the load-bearing kernel
 * id literals (claude-code / codex / cursor-agent / codebuddy / forgeax-core)
 * appear verbatim, never product codenames.
 */
import type { AgentKernel } from '@forgeax/agent-runtime';

/** Why a kernel could not serve the turn. Closed union so a reader knows the
 *  full space of causes the UI may see. */
export type KernelUnavailableReason =
  | 'unknown-id' // requested id is not a registered kernel at all
  | 'not-registered' // default/built-in kernel not registered into the runtime
  | 'not-installed' // third-party CLI binary missing from PATH
  | 'not-logged-in' // installed but missing login / credentials
  | 'not-ready'; // reachable but failed readiness for another reason

/** Thrown by `resolveKernel` when selection itself fails (registration causes).
 *  Carries the structured cause so the SSE exit can translate without re-parsing
 *  a string. Still an `Error`, so existing `catch`/swallow callers are unaffected. */
export class KernelUnavailableError extends Error {
  readonly kernelId: string;
  readonly reason: KernelUnavailableReason;
  constructor(kernelId: string, reason: KernelUnavailableReason, detail?: string) {
    super(describeKernelUnavailable(kernelId, reason, detail));
    this.name = 'KernelUnavailableError';
    this.kernelId = kernelId;
    this.reason = reason;
  }
}

/** Infer the cause from a kernel `probe()` detail string (free-form per kernel).
 *  Conservative: only the two structurally-distinct causes (missing binary /
 *  missing login) are pattern-matched; everything else stays `not-ready`. */
export function classifyProbeDetail(detail?: string): KernelUnavailableReason {
  const d = (detail ?? '').toLowerCase();
  if (/enoent|not on path|not found|no such file|command not found/.test(d)) return 'not-installed';
  if (/login|log in|api[_ ]?key|auth|credential|not authenticated|unauthor/.test(d)) return 'not-logged-in';
  return 'not-ready';
}

/** Per-kernel remediation hint, keyed by the load-bearing kernel id literal.
 *  `docs` is the CLI's official setup page — always surfaced so the user can go
 *  straight to authoritative install/login instructions. Built-in kernels
 *  (forgeax-core) have no external CLI, hence no docs/install/login step. */
const FIX_HINTS: Record<string, { install?: string; login?: string; docs?: string }> = {
  'claude-code': {
    install: '安装 claude 命令行工具并确保它在 PATH 中',
    login: '设置 ANTHROPIC_API_KEY 环境变量,或在终端运行 `claude` 完成登录',
    docs: 'https://code.claude.com/docs/en/setup',
  },
  codex: {
    install: '安装 codex 命令行工具并确保它在 PATH 中',
    login: '设置 OPENAI_API_KEY 环境变量,或运行 `codex login` 完成登录',
    docs: 'https://developers.openai.com/codex/cli',
  },
  'cursor-agent': {
    install: '安装 cursor-agent 并确保它在 PATH 中',
    login: '运行 `cursor-agent login` 完成登录',
    docs: 'https://cursor.com/docs/cli/installation',
  },
  codebuddy: {
    install: '安装 codebuddy 命令行工具并确保它在 PATH 中',
    login: '在终端运行 `codebuddy` 完成登录',
    docs: 'https://www.codebuddy.ai/docs/cli/',
  },
  'forgeax-core': {},
};

/** Append the CLI's official setup doc link when known, so every reminder ends
 *  with an authoritative next step. */
function withDocs(kernelId: string, message: string): string {
  const docs = FIX_HINTS[kernelId]?.docs;
  return docs ? `${message}(配置文档:${docs})` : message;
}

/** Build the human-facing message for a given kernel + cause. `detail` carries
 *  extra context per reason (available kernel ids for `unknown-id`; the raw probe
 *  detail for `not-ready`). */
export function describeKernelUnavailable(
  kernelId: string,
  reason: KernelUnavailableReason,
  detail?: string,
): string {
  const hint = FIX_HINTS[kernelId] ?? {};
  switch (reason) {
    case 'not-installed':
      return withDocs(
        kernelId,
        `内核「${kernelId}」不可用:未检测到它所需的命令行工具。${
          hint.install ? `修复:${hint.install}。` : '请先安装对应的命令行工具并确保它在 PATH 中。'
        }`,
      );
    case 'not-logged-in':
      return withDocs(
        kernelId,
        `内核「${kernelId}」不可用:已安装但缺少登录/凭据。${
          hint.login ? `修复:${hint.login}。` : '请先完成该内核的登录或配置访问凭据。'
        }`,
      );
    case 'unknown-id':
      return `未知内核「${kernelId}」:当前没有注册这个内核,请在内核选择器里改选一个可用内核${
        detail ? `(可用:${detail})` : ''
      }。`;
    case 'not-registered':
      return `内核「${kernelId}」未注册到运行时。请检查 FORGEAX_KERNEL_IMPL 是否指向一个已注册的内核,或确认产品外壳已在启动时注册该内置内核。`;
    case 'not-ready':
    default:
      return withDocs(
        kernelId,
        `内核「${kernelId}」当前不可用${detail ? `:${detail}` : ''}。请检查它的安装、登录与配置后重试。`,
      );
  }
}

/** SSE `error` payload for the chat stream. Superset of the wire `error` variant
 *  ({ type, message, code }) with optional structured cause fields the UI can use
 *  later (e.g. grey out the kernel selector); older clients read `message` only. */
export interface KernelErrorPayload {
  type: 'error';
  message: string;
  code: string;
  kernelId?: string;
  reason?: KernelUnavailableReason;
}

/**
 * Single translation point for the chat SSE error exit. Given the failing kernel
 * (or null when selection itself failed) and a raw error, decide whether the
 * kernel is the culprit and produce a friendly, cause-aware payload.
 *
 *  - A `KernelUnavailableError` (from resolveKernel) is already classified → use it.
 *  - Otherwise ask the kernel's own `probe()` — the readiness authority: probe
 *    not-ok ⇒ the kernel is down (friendly `kernel_unavailable`); probe ok ⇒ a
 *    genuine runtime error (network / LLM / tool), preserved verbatim with a
 *    neutral code so it is no longer MISLABELED as `kernel_unavailable`.
 *
 * Probe runs only on the (rare) error path, so the happy path pays nothing.
 *
 * @param rawCode  the code already on a yielded wire error (e.g. 'protocol'),
 *                 preserved when the kernel turns out healthy.
 */
export async function toKernelErrorPayload(
  kernel: AgentKernel | null,
  raw: unknown,
  rawCode?: string,
): Promise<KernelErrorPayload> {
  if (raw instanceof KernelUnavailableError) {
    return {
      type: 'error',
      message: raw.message,
      code: 'kernel_unavailable',
      kernelId: raw.kernelId,
      reason: raw.reason,
    };
  }
  const rawMessage =
    raw instanceof Error ? raw.message : String((raw as { message?: unknown } | null)?.message ?? raw);
  if (kernel) {
    try {
      const health = await kernel.probe();
      if (!health.ok) {
        const reason = classifyProbeDetail(health.detail);
        return {
          type: 'error',
          message: describeKernelUnavailable(kernel.id, reason, health.detail),
          code: 'kernel_unavailable',
          kernelId: kernel.id,
          reason,
        };
      }
    } catch {
      // probe itself threw → treat the kernel as not-ready rather than masking it
      // as a plain turn error (its readiness could not be established).
      return {
        type: 'error',
        message: describeKernelUnavailable(kernel.id, 'not-ready', rawMessage),
        code: 'kernel_unavailable',
        kernelId: kernel.id,
        reason: 'not-ready',
      };
    }
  }
  // Kernel is healthy (or unknown): a real runtime error, NOT a missing kernel.
  return { type: 'error', message: rawMessage, code: rawCode ?? 'turn_failed' };
}
