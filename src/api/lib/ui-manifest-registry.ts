/** ui-manifest-registry —— UI 语义操作层(产品 AI 化 P0)的两个进程内中枢:
 *
 *  1. **action manifest per-sid 缓存**:UI 侧 ActionRegistry 变更时把可序列化 manifest
 *     POST `/:sid/ui-manifest` 推进来。它是 **trust-gate 的权限输入**——`ui_invoke` 的
 *     capability 按 manifest 里**声明的**值查表(不信模型自报的 args,防谎报),查不到
 *     的 actionId 由闸 fail-closed(ask)。因此写入被 lease 把守(见 2),且校验失败的
 *     条目**整条丢弃**(宁缺勿错:缺失 → ask,错误 capability → 可能静默直放)。
 *
 *  2. **UI surface lease**:多标签同 sid 时,「最后获焦的 tab」持有 lease 才是 manifest
 *     的权威来源 + ui_* 感知往返的应答方(声明与执行方必须是同一个 surface,否则
 *     A tab 持 lease 执行、B tab 推声明会出现权限声明与实际行为分离)。获焦即 acquire
 *     (displace 语义:焦点是客户端真值,后来者取代),心跳续期,TTL 过期视为无主。
 *
 *  模块级 Map(单进程 Bun 安全)。重启丢缓存 → 权限查表 miss → fail-closed ask,
 *  UI 重连后重推 manifest 自愈(§9 优雅降级)。
 */
import { randomUUID } from 'node:crypto';
import type { Capability } from '../../kernel/trust-gate';

/** manifest 里一条 action 的声明(可序列化子集;函数永不过 wire)。 */
export interface UiActionDecl {
  id: string;
  title: string;
  description?: string;
  inputSchema?: unknown;
  capability: Capability;
  surface?: 'ui' | 'server' | 'both';
  /** 预期执行时长(ms);ui_invoke 往返超时据此放宽(clamp 后),缺省走通道默认。 */
  timeoutMs?: number;
  /** P1-9 一等工具化:标 true 的 action 派生独立 ToolSpec(`ui_act_<id>`)下发模型,
   *  免一次 snapshot 发现往返;执行/权限仍反解回 ui_invoke 同一条路。 */
  firstClass?: boolean;
}

/** lease TTL:心跳按 TTL/2 续期;过期视为无主(任何 tab 可 acquire)。 */
export const UI_LEASE_TTL_MS = 30_000;

/** manifest 尺寸护栏(防失控 payload 撑爆内存/prompt)。超限截断,fail-soft。 */
const MAX_ACTIONS_PER_SID = 500;
const MAX_TEXT_LEN = 2_000;

const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'read', 'write', 'delete', 'exec', 'network', 'credential', 'delegate', 'other',
]);

interface SidUiState {
  lease?: { leaseId: string; clientId: string; expiresAt: number };
  actions: Map<string, UiActionDecl>;
  manifestTs: number;
}

const states = new Map<string, SidUiState>();

function stateFor(sid: string): SidUiState {
  let s = states.get(sid);
  if (!s) {
    s = { actions: new Map(), manifestTs: 0 };
    states.set(sid, s);
  }
  return s;
}

// ─── lease ──────────────────────────────────────────────────────────────────

/** 获取/续期 lease。displace 语义:焦点是客户端真值,「最后获焦 tab」调用即取代
 *  前任(同 clientId 续期保持 leaseId 稳定,便于客户端持有)。 */
export function acquireUiLease(sid: string, clientId: string): { leaseId: string; ttlMs: number } {
  const s = stateFor(sid);
  const now = Date.now();
  if (s.lease && s.lease.clientId === clientId && s.lease.expiresAt > now) {
    s.lease.expiresAt = now + UI_LEASE_TTL_MS; // 心跳续期,leaseId 不变
    return { leaseId: s.lease.leaseId, ttlMs: UI_LEASE_TTL_MS };
  }
  const leaseId = randomUUID();
  s.lease = { leaseId, clientId, expiresAt: now + UI_LEASE_TTL_MS };
  return { leaseId, ttlMs: UI_LEASE_TTL_MS };
}

/** 校验 leaseId 当前有效(存在、匹配、未过期)。manifest 写入与 ui_* 感知回灌都以此把关。 */
export function validateUiLease(sid: string, leaseId: unknown): boolean {
  if (typeof leaseId !== 'string' || !leaseId) return false;
  const s = states.get(sid);
  return !!s?.lease && s.lease.leaseId === leaseId && s.lease.expiresAt > Date.now();
}

// ─── manifest ───────────────────────────────────────────────────────────────

/** 单条声明的校验 + 规整。不合格返回 null(整条丢弃,fail-closed:查表 miss → ask)。 */
function sanitizeDecl(raw: unknown): UiActionDecl | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const capability = typeof o.capability === 'string' ? o.capability : '';
  // capability 是权限输入:非法值不降级为 other(own tier 的 other 会静默直放),整条丢。
  if (!id || !title || !VALID_CAPABILITIES.has(capability)) return null;
  const surface = o.surface === 'ui' || o.surface === 'server' || o.surface === 'both' ? o.surface : undefined;
  const timeoutMs = typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
    ? Math.floor(o.timeoutMs)
    : undefined;
  return {
    id: id.slice(0, 200),
    title: title.slice(0, MAX_TEXT_LEN),
    ...(typeof o.description === 'string' ? { description: o.description.slice(0, MAX_TEXT_LEN) } : {}),
    ...(o.inputSchema && typeof o.inputSchema === 'object' ? { inputSchema: o.inputSchema } : {}),
    capability: capability as Capability,
    ...(surface ? { surface } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(o.firstClass === true ? { firstClass: true } : {}),
  };
}

/** 写入 manifest(整表替换,幂等)。**必须持有效 lease**(权限输入的信任锚,见文件头)。
 *  返回 accepted/dropped 计数供 UI 侧自检。 */
export function setUiManifest(
  sid: string,
  rawActions: unknown,
  leaseId: unknown,
): { ok: boolean; reason?: string; accepted?: number; dropped?: number } {
  if (!validateUiLease(sid, leaseId)) return { ok: false, reason: 'invalid-or-expired-lease' };
  if (!Array.isArray(rawActions)) return { ok: false, reason: 'actions must be an array' };
  const s = stateFor(sid);
  const next = new Map<string, UiActionDecl>();
  let dropped = 0;
  for (const raw of rawActions.slice(0, MAX_ACTIONS_PER_SID)) {
    const decl = sanitizeDecl(raw);
    if (decl) next.set(decl.id, decl);
    else dropped++;
  }
  dropped += Math.max(0, rawActions.length - MAX_ACTIONS_PER_SID);
  s.actions = next;
  s.manifestTs = Date.now();
  return { ok: true, accepted: next.size, dropped };
}

/** 权限/超时查表:按 actionId 取声明。miss → undefined(调用方 fail-closed)。 */
export function getUiAction(sid: string | undefined, actionId: unknown): UiActionDecl | undefined {
  if (!sid || typeof actionId !== 'string' || !actionId) return undefined;
  return states.get(sid)?.actions.get(actionId);
}

/** ui_invoke 往返超时:action 声明了 timeoutMs 则用之(clamp 到 [1s, 30s]),否则通道默认。 */
export function uiInvokeTimeoutMs(sid: string | undefined, actionId: unknown, defaultMs: number): number {
  const decl = getUiAction(sid, actionId);
  if (!decl?.timeoutMs) return defaultMs;
  return Math.min(30_000, Math.max(1_000, decl.timeoutMs));
}

// ─── P1-9 一等工具化:firstClass action ⇄ ui_act_* 工具名 ──────────────────

const FIRST_CLASS_PREFIX = 'ui_act_';
/** 一等工具数量上限(防长尾 manifest 撑爆 prompt 工具区;超出的仍走 snapshot 发现式)。 */
const MAX_FIRST_CLASS_TOOLS = 24;

function firstClassToolName(actionId: string): string {
  return FIRST_CLASS_PREFIX + actionId.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

/** manifest 里标 firstClass 的 action → 派生中立 ToolSpec(下发模型)。
 *  名字冲突(不同 id 消毒后同名)后到者跳过;description 带上 ui_invoke 同款结果语义。 */
export function firstClassUiToolSpecs(
  sid: string | undefined,
): Array<{ name: string; description: string; inputSchema: unknown }> {
  if (!sid) return [];
  const s = states.get(sid);
  if (!s) return [];
  const out: Array<{ name: string; description: string; inputSchema: unknown }> = [];
  const taken = new Set<string>();
  for (const decl of s.actions.values()) {
    if (!decl.firstClass || out.length >= MAX_FIRST_CLASS_TOOLS) continue;
    const name = firstClassToolName(decl.id);
    if (taken.has(name)) continue;
    taken.add(name);
    out.push({
      name,
      description:
        `[UI action] ${decl.title}. ${decl.description ?? ''} ` +
        `Executes on the connected UI surface; result semantics match ui_invoke ` +
        `({ status: completed|accepted|rejected, reason?, stateDigest? } — on 'accepted' do NOT wait or retry, ` +
        `confirm later via ui_snapshot).`,
      inputSchema: decl.inputSchema ?? { type: 'object', properties: {} },
    });
  }
  return out;
}

/** 反解一等工具名 → actionId(两个 host 工具执行口在信任闸**之前**翻译回 ui_invoke,
 *  使权限/审计/执行全程只认识 ui_invoke 一条路)。非 ui_act_* / 查不到 → undefined。 */
export function resolveFirstClassUiTool(sid: string | undefined, toolName: string): { actionId: string } | undefined {
  if (!sid || !toolName.startsWith(FIRST_CLASS_PREFIX)) return undefined;
  const s = states.get(sid);
  if (!s) return undefined;
  for (const decl of s.actions.values()) {
    if (decl.firstClass && firstClassToolName(decl.id) === toolName) return { actionId: decl.id };
  }
  return undefined;
}

/** session dispose 时清理(lease + manifest 都不跨会话残留)。 */
export function clearUiStateForSession(sid: string): void {
  states.delete(sid);
}
