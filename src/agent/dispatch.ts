/**
 * Tool dispatch (Wave3 LOOP, K3/K5) — serial/parallel partition + 权限把闸 + hook block.
 *
 * partitionToolCalls(连续并发安全→并行批,
 * 否则单工具串行) + `toolExecution.ts`(schema parse → 权限 → call → mapResult)。
 * Boundary: 仅 core 相对 import。
 */
import type { AgentTool, ToolContext, PermissionResult } from '../capability/types';
import type { CoreEvent } from '../events/types';
import {
  hasPermissionsToUseTool,
  checkRuleBasedPermissions,
  type PermissionMode,
} from '../permission/engine';
import type { PermissionRuleSet } from '../permission/rules';
import { validateAgainstSchema } from '../capability/validate';
import { coerceBySchema } from '../capability/coerce';

/** 交互式权限回路:当把闸判定 'ask' 时,host 决定放行与否(REPL 提示 / 策略)。
 *  无此回调 → 'ask' 一律 fail-closed(deny)。 */
export type AskUserFn = (perm: PermissionResult, use: ToolUse) => Promise<boolean>;

/** 工具错误五类(移植 agentic_os 03.E.1)。仅供诊断聚合 + LOOP 循环兜底(02.4)判定用,
 *  不进 LLM-visible 文案、不指挥模型恢复(工程只分类,模型自决)。 */
export type ErrorCategory =
  | 'validation' // schema/参数校验失败
  | 'unknown_tool' // 工具名不在工具集
  | 'permission_denied' // 权限/hook 拒绝
  | 'timeout' // 执行超时 / abort
  | 'runtime_error'; // 其余 handler 执行期异常

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolDispatchResult {
  toolUseId: string;
  toolName: string;
  result: CoreEvent;
  isError: boolean;
  /** 错误五类(仅 isError 时设);LOOP 用之做循环兜底,诊断用之聚合。 */
  errorCategory?: ErrorCategory;
  /** 输入校验失败时的 JSON Path(如 `$.a.b[0]`);仅 errorCategory==='validation' 设。 */
  validationPath?: string;
  /** 工具专属 validateInput 的稳定错误码。 */
  validationCode?: number;
  /** 工具产生的附加消息(如 skill inline 展开的 prompt);loop 回灌进上下文。 */
  newMessages?: CoreEvent[];
}

export interface DispatchDeps {
  tools: AgentTool[];
  toolContext: Omit<ToolContext, 'signal'>;
  signal: AbortSignal;
  rules?: Partial<PermissionRuleSet> | null;
  mode?: PermissionMode;
  /** 是否启用 core 内置受保护路径 safetyCheck(默认 false;CLI 独立形态可开,serve/Studio 关)。 */
  enableSafetyCheck?: boolean;
  /** trust channel：agent_command 绕过权限把闸（C5 §5）。 */
  trusted?: boolean;
  /** hook block 检查：返回 true 表示该工具调用被 hook 拦下（K1/K5）。 */
  isBlocked?: (use: ToolUse) => boolean;
  /**
   * PreToolUse hook 权限三态(`permissionDecision`):
   *  - `'allow'` → 旁路权限引擎,直接放行(免审批卡);
   *  - `'deny'`  → 拒绝(通常同时经 isBlocked 拦下,这里冗余兜底);
   *  - `'ask'`   → 强制交互式审批(即便引擎判 allow 也要 askUser 确认);
   *  - `undefined` → 无 hook 意见,走常规权限引擎。
   * 与 isBlocked 共用同一次 PreToolUse 发布(host 缓存回执),不重复触发 hook。
   */
  preToolPermission?: (use: ToolUse) => 'allow' | 'deny' | 'ask' | undefined;
  /** 交互式权限:'ask' 判定时咨询;无则 'ask' fail-closed(deny)。 */
  askUser?: AskUserFn;
}

/** 别名感知匹配:模型发来的名(可能是别名 PascalCase)→ 真工具对象。
 *  `t.name === name || t.aliases?.includes(name)`(与 agent.ts:212 同款)。
 *  P1 export 供 host 层 driver.toolMeta 复用,避免平行实现(SSOT,见地基方案 §3梁①)。 */
export function findTool(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name || (t.aliases?.includes(name) ?? false));
}

function errorEvent(
  toolUseId: string,
  message: string,
  errorCategory?: ErrorCategory,
  validationPath?: string,
): CoreEvent {
  return {
    type: 'tool.result',
    payload: {
      toolUseId,
      isError: true,
      message,
      ...(errorCategory ? { errorCategory } : {}),
      ...(validationPath ? { validationPath } : {}),
    },
    ts: 0,
  };
}

/** 把 catch 到的异常归类(就近赋类,移植 03.E.1):abort/超时 → timeout;zod-like → validation;
 *  其余 → runtime_error。signal.aborted 优先判 timeout(中断当作可重试类)。 */
function classifyThrown(e: unknown, signal: AbortSignal): ErrorCategory {
  if (signal.aborted) return 'timeout';
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed out|timeout|abort/i.test(msg)) return 'timeout';
  // zod / JSON-schema 校验错通常带 issues 数组。
  if (e && typeof e === 'object' && Array.isArray((e as { issues?: unknown }).issues)) return 'validation';
  return 'runtime_error';
}

type InputDecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; path: string; message: string };

function parserFailure(error: unknown): { path: string; message: string } {
  if (error && typeof error === 'object') {
    const issues = (error as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0] as { path?: unknown; message?: unknown };
      const segments = Array.isArray(first.path) ? first.path : [];
      const path = segments.reduce<string>(
        (out, segment) => typeof segment === 'number' ? `${out}[${segment}]` : `${out}.${String(segment)}`,
        '$',
      );
      const message = typeof first.message === 'string' ? first.message : String(error);
      return { path, message };
    }
  }
  if (error === undefined) return { path: '$', message: 'input does not match the declared schema' };
  return { path: '$', message: error instanceof Error ? error.message : String(error) };
}

/**
 * 工具输入的单一解码边界：parser 优先；声明式工具走克制 coercion + JSON Schema。
 * 任一显式契约失配都 fail-fast，绝不把 raw input 继续送进权限或 handler。
 */
function decodeInput(tool: AgentTool, raw: unknown): InputDecodeResult {
  if (tool.inputSchema) {
    try {
      const parsed = tool.inputSchema.safeParse(raw);
      if (parsed.success) {
        // 兼容旧 parser ABI：success 曾允许省略 data，由 parse 承担实际解码。
        const value = Object.hasOwn(parsed, 'data') ? parsed.data : tool.inputSchema.parse(raw);
        return { ok: true, value };
      }
      const failure = parserFailure((parsed as { error?: unknown }).error);
      return { ok: false, ...failure };
    } catch (error) {
      return { ok: false, ...parserFailure(error) };
    }
  }

  if (tool.inputJSONSchema) {
    const value = coerceBySchema(raw, tool.inputJSONSchema);
    const checked = validateAgainstSchema(value, tool.inputJSONSchema);
    if (!checked.ok) return checked;
    return { ok: true, value };
  }

  return { ok: true, value: raw };
}

function inputValidationError(
  use: ToolUse,
  path: string,
  message: string,
  validationCode?: number,
): ToolDispatchResult {
  const text = `InputValidationError for ${use.name} at ${path}: ${message}`;
  return {
    toolUseId: use.id,
    toolName: use.name,
    result: errorEvent(use.id, text, 'validation', path),
    isError: true,
    errorCategory: 'validation',
    validationPath: path,
    ...(validationCode !== undefined ? { validationCode } : {}),
  };
}

async function runOne(use: ToolUse, deps: DispatchDeps): Promise<ToolDispatchResult> {
  const tool = findTool(deps.tools, use.name);
  if (!tool) {
    return { toolUseId: use.id, toolName: use.name, result: errorEvent(use.id, `unknown tool: ${use.name}`, 'unknown_tool'), isError: true, errorCategory: 'unknown_tool' };
  }
  const ctx: ToolContext = { ...deps.toolContext, signal: deps.signal, toolUseId: use.id };
  const decoded = decodeInput(tool, use.input);
  if (!decoded.ok) return inputValidationError(use, decoded.path, decoded.message);
  const parsed = decoded.value;
  // 下游观察者只接触契约化输入；保留 id/name，替换模型原始 input。
  const validatedUse: ToolUse = { ...use, input: parsed };

  // 对齐通用工具边界：工具专属语义校验在 hook / 权限 / call 之前运行。
  if (tool.validateInput) {
    let validated;
    try {
      validated = await tool.validateInput(parsed, ctx);
    } catch (error) {
      return inputValidationError(use, '$', error instanceof Error ? error.message : String(error));
    }
    if (!validated.result) {
      return inputValidationError(use, '$', validated.message, validated.errorCode);
    }
  }

  // 只有合法输入才触发 PreToolUse，避免 hooks 观察或处理不可执行的伪调用。
  if (deps.isBlocked?.(validatedUse)) {
    return { toolUseId: use.id, toolName: use.name, result: errorEvent(use.id, `blocked by hook`, 'permission_denied'), isError: true, errorCategory: 'permission_denied' };
  }

  // PreToolUse hook 权限三态(permissionDecision):在引擎把闸之前裁决。
  const hookPerm = deps.preToolPermission?.(validatedUse);
  if (hookPerm === 'deny') {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: errorEvent(use.id, `denied by hook (permissionDecision)`, 'permission_denied'),
      isError: true,
      errorCategory: 'permission_denied',
    };
  }

  // 权限把闸（trust channel 绕过；K5）。
  let callInput: unknown = parsed;
  if (!deps.trusted && hookPerm === 'allow') {
    // hook 'allow' 免「审批卡」,但**不越过** settings deny/ask 与受保护路径 safetyCheck
    //（deny 是 K5 最强不变量,hook 不可削弱）。只跑规则子集 ①deny ②ask ⑤safetyCheck:
    //   deny → 拒;ask → 转 askUser(无回调 fail-closed deny);null → 放行(跳过审批卡)。
    const sub = await checkRuleBasedPermissions(
      tool,
      parsed,
      ctx,
      deps.rules,
      deps.enableSafetyCheck,
    );
    if (sub?.behavior === 'deny') {
      return {
        toolUseId: use.id,
        toolName: use.name,
        result: errorEvent(use.id, sub.message ?? `permission denied for ${use.name}`, 'permission_denied'),
        isError: true,
        errorCategory: 'permission_denied',
      };
    }
    if (sub?.behavior === 'ask') {
      let granted = false;
      if (deps.askUser) {
        try {
          granted = await deps.askUser(sub, validatedUse);
        } catch {
          granted = false; // 咨询抛错 → fail-closed
        }
      }
      if (!granted) {
        return {
          toolUseId: use.id,
          toolName: use.name,
          result: errorEvent(use.id, sub.message ?? `permission ask for ${use.name}`, 'permission_denied'),
          isError: true,
          errorCategory: 'permission_denied',
        };
      }
    }
    callInput = sub?.updatedInput ?? parsed;
  } else if (!deps.trusted) {
    const perm = await hasPermissionsToUseTool(tool, parsed, ctx, deps.rules, {
      mode: deps.mode,
      enableSafetyCheck: deps.enableSafetyCheck,
    });
    // hook 'ask' → 强制交互式审批(即便引擎判 allow);否则按引擎行为。
    const mustAsk = hookPerm === 'ask';
    let granted = !mustAsk && perm.behavior === 'allow';
    // 'ask'(引擎判或 hook 强制)→ 交互式裁决(有回调才可能放行;无 → fail-closed deny)。'deny' 永不咨询。
    if (!granted && perm.behavior !== 'deny' && (perm.behavior === 'ask' || mustAsk) && deps.askUser) {
      try {
        granted = await deps.askUser(perm, validatedUse);
      } catch {
        granted = false; // 咨询抛错 → fail-closed
      }
    }
    if (!granted) {
      return {
        toolUseId: use.id,
        toolName: use.name,
        result: errorEvent(use.id, perm.message ?? `permission ${perm.behavior} for ${use.name}`, 'permission_denied'),
        isError: true,
        errorCategory: 'permission_denied',
      };
    }
    callInput = perm.updatedInput ?? parsed;
  }

  try {
    const out = await tool.call(callInput, ctx);
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: tool.mapResult(out.data, use.id),
      isError: false,
      newMessages: out.newMessages,
    };
  } catch (e) {
    const category = classifyThrown(e, deps.signal);
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: errorEvent(use.id, e instanceof Error ? e.message : String(e), category),
      isError: true,
      errorCategory: category,
    };
  }
}

/** 把连续的并发安全工具分到同一并行批；非并发安全工具自成串行单元
 *  (partitionToolCalls)。isConcurrencySafe 抛错 → 当作不安全 (fail-closed)。 */
export function partition(uses: ToolUse[], tools: AgentTool[]): ToolUse[][] {
  const batches: ToolUse[][] = [];
  let cur: ToolUse[] = [];
  for (const use of uses) {
    const tool = findTool(tools, use.name);
    let safe = false;
    if (tool) {
      try {
        const decoded = decodeInput(tool, use.input);
        safe = decoded.ok && tool.isConcurrencySafe(decoded.value);
      } catch {
        safe = false;
      }
    }
    if (safe) {
      cur.push(use);
    } else {
      if (cur.length) batches.push(cur), (cur = []);
      batches.push([use]);
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** 按批 dispatch：并发安全批并行,其余串行。保持工具调用的原始顺序产出结果。 */
export async function dispatchTools(uses: ToolUse[], deps: DispatchDeps): Promise<ToolDispatchResult[]> {
  const out: ToolDispatchResult[] = [];
  for (const batch of partition(uses, deps.tools)) {
    if (deps.signal.aborted) break;
    if (batch.length === 1) {
      out.push(await runOne(batch[0], deps));
    } else {
      const results = await Promise.all(batch.map((u) => runOne(u, deps)));
      out.push(...results);
    }
  }
  return out;
}
