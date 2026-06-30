/**
 * tool-approval —— host 选择点把信任闸的 `ask` 决策翻成「弹卡 + 阻塞等用户」往返。
 *
 * 信任闸(trust-gate.ts)只产出 allow/ask/deny 三档**策略**;真正的交互在这里落地:
 *   - `requestToolApproval` 复用 permission-registry(与 `:sid/permission-request` 同一往返)
 *     —— 经 session EventBus 弹 `permission:request` 卡 → 阻塞 Promise → 用户在 UI 回执
 *     (`:sid/permission-reply` → resolvePermission)→ allow/deny;超时 fail-closed deny。
 *   - **本会话 remember**:用户勾「记住本会话」时,reply 携带 `remember` → 记住该 agent 的
 *     该 capability,本会话内同类操作免卡直放(session dispose 时清)。
 *
 * 单一选择点价值:forgeax-core 的**所有工具都经 host 回调**(host-tool-bridge / `:sid/kernel-tool`),
 * 故只在这两处接 ask→卡 即覆盖默认内核全部工具,**无需给 serve.ts 加反向 permission RPC**。
 */
import { randomUUID } from 'node:crypto';
import { registerPermission } from '../core/permission-registry';
import type { EventBus } from '../core/event-bus';
import type { Capability } from './trust-gate';

/** 与 `:sid/permission-request` 一致的审批超时(10 分钟,超时 fail-closed deny)。 */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** 本会话已记住放行的 capability:sid → Set<capability>。session dispose 时清。 */
const remembered = new Map<string, Set<string>>();
/** reqId → {sid, agent, capability},供 reply 携带 remember 时回填 remembered。 */
const pendingCtx = new Map<string, { sid: string; agent: string; capability: string }>();

/** 本会话是否已记住该 capability。 */
export function isApprovalRemembered(sid: string, capability: string): boolean {
  return remembered.get(sid)?.has(capability) ?? false;
}

/** 记住本会话该 capability(用户勾「记住」)。 */
function rememberApproval(sid: string, capability: string): void {
  let set = remembered.get(sid);
  if (!set) {
    set = new Set<string>();
    remembered.set(sid, set);
  }
  set.add(capability);
}

/** session dispose 时调用:清掉该会话所有 remember(不跨会话残留)。 */
export function clearRememberedForSession(sid: string): void {
  remembered.delete(sid);
}

/** reply 端在 resolvePermission 之前调用:若 allow && remember,按该 reqId 的 capability 记住本会话。 */
export function applyRememberOnReply(reqId: string, allow: boolean, remember: boolean): void {
  if (!allow || !remember) return;
  const ctx = pendingCtx.get(reqId);
  if (ctx) rememberApproval(ctx.sid, ctx.capability);
}

export interface ApprovalRequest {
  eventBus: EventBus;
  sid: string;
  agent: string;
  toolName: string;
  capability?: Capability;
  /** 工具入参(透传给卡片展示,如 Bash 的 command)。 */
  args?: unknown;
  /** 闸给出的人类可读原因(卡片副标题)。 */
  reason?: string;
}

/**
 * 弹卡 + 阻塞等用户审批。命中本会话 remember → 直接 allow(免卡)。
 * 返回 true=放行 / false=拒绝(含超时 fail-closed)。
 */
export async function requestToolApproval(req: ApprovalRequest): Promise<boolean> {
  const cap = req.capability ?? 'other';
  if (isApprovalRemembered(req.sid, cap)) return true;

  const reqId = randomUUID();
  pendingCtx.set(reqId, { sid: req.sid, agent: req.agent, capability: cap });

  // 弹审批卡(与 `:sid/permission-request` 同款 per-session WS fan-out;UI 按 reqId 渲染模态)。
  // 携带 capability + canRemember,让卡片可展示「记住本会话」选项。
  req.eventBus.publish(
    {
      type: 'permission:request',
      ts: Date.now(),
      source: `agent:${req.agent}`,
      payload: {
        reqId,
        toolName: req.toolName,
        command: extractCommand(req.args),
        input: req.args ?? null,
        agent: req.agent,
        capability: cap,
        reason: req.reason ?? null,
        canRemember: true,
      },
    },
    req.agent,
  );

  const handle = registerPermission(reqId, APPROVAL_TIMEOUT_MS, { sid: req.sid, agent: req.agent });
  let allow = false;
  try {
    allow = await handle.promise;
  } finally {
    handle.dispose();
    pendingCtx.delete(reqId);
    // 无论 reply/超时/abort,都通知 UI 撤卡,避免残留。
    req.eventBus.publish(
      { type: 'permission:resolved', ts: Date.now(), source: `agent:${req.agent}`, payload: { reqId, allow } },
      req.agent,
    );
  }
  return allow;
}

/** 从工具入参里取一个适合卡片展示的 command 串(Bash 等)。拿不到 → 空串。 */
function extractCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const o = args as Record<string, unknown>;
  for (const k of ['command', 'cmd', 'script']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return '';
}
