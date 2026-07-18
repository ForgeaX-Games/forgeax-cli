/**
 * host-tool-bridge —— 编排层(cli)提供给「原生 in-process 内核」的 host 工具执行桥。
 *
 * 它把内核发起的工具调用接到 cli 的宿主能力上(与 `POST /:sid/kernel-tool` 同一信任闸口
 * T-D,免 HTTP):定位活 agent → loadAgentRecord 权威 trustTier → checkKernelTool →
 * (ask → 弹卡等用户)→ executeTool。
 *
 * 三档闸:allow 直跑;deny 抛;**ask 经 `requestToolApproval` 弹权限卡阻塞等用户**
 * (own 危险操作 / imported exec·network·游戏内写删 → 确认;命中本会话 remember 免卡)。
 * 这是 forgeax-core 默认内核唯一的交互式审批接入点(serve 的所有工具都回调到此)。
 *
 * DIP 边界:本桥**只依赖 cli 内部**(session / soul / trust-gate / tool-approval / tool-executor),
 * 不 import 任何具体内核包。产品壳(packages/server)在装配原生内核时复用本桥,从而 cli 不反向依赖内核实现。
 */
import { getSessionManager } from '../core/session-manager';
import { loadAgentRecord } from '../soul';
import { checkKernelTool } from './trust-gate';
import { requestToolApproval } from './tool-approval';
import { executeTool } from '../kits/tool/tool-executor';
import { isForgeaxBuiltinTool, runForgeaxBuiltinTool, hostToolRunCtx } from './forgeax-builtin-tools';
import { resolveFirstClassUiTool } from '../api/lib/ui-manifest-registry';
import { getHostTool } from '../orchestration-seams';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getPathManager } from '../fs/path-manager';
import { tt } from '../lib/turn-trace';
import { appendToolAudit } from './tool-audit';
import { shouldDelegateHostToolConfirmation } from './host-tool-confirmation';

/** 与原生内核约定的 host 工具执行签名(结构化,不 import 内核包的类型)。
 *  `agentId` = 本轮真实发起工具的 agent(委派轮里即被委派方,如 mochi);缺省回落 defaultAgentPath。
 *  `callId` = 本轮工具调用 id(= tool.call/tool.result 的 callId);外部宿主(studio)据它把
 *  前端 HITL 卡片的 pending 表 key 钉在同一 id 上,使前端回填对得上。cli 内建桥不用它。 */
export type HostExecuteToolFn = (name: string, args: unknown, sid?: string, agentId?: string, callId?: string) => Promise<unknown>;

/** 桥的可注入协作方(显式声明的输入,Pipeline Isolation)。生产路径全部省略 → 用真实 cli
 *  内部实现;单测可注入桩驱动各决策出口,免起活 session、零全局 mock。`appendToolAudit`
 *  始终走真实实现(其副作用即被断言的审计行)。 */
export interface HostToolBridgeDeps {
  getSessionManager: typeof getSessionManager;
  loadAgentRecord: typeof loadAgentRecord;
  checkKernelTool: typeof checkKernelTool;
  shouldDelegateHostToolConfirmation: typeof shouldDelegateHostToolConfirmation;
  requestToolApproval: typeof requestToolApproval;
  executeTool: typeof executeTool;
}

/** in-process host-tool 桥:与 `POST /:sid/kernel-tool` 同一信任闸口(T-D),免 HTTP。 */
export function makeInProcessExecuteTool(
  defaultAgentPath = 'forge',
  deps: Partial<HostToolBridgeDeps> = {},
): HostExecuteToolFn {
  const _getSessionManager = deps.getSessionManager ?? getSessionManager;
  const _loadAgentRecord = deps.loadAgentRecord ?? loadAgentRecord;
  const _checkKernelTool = deps.checkKernelTool ?? checkKernelTool;
  const _shouldDelegateHostToolConfirmation =
    deps.shouldDelegateHostToolConfirmation ?? shouldDelegateHostToolConfirmation;
  const _requestToolApproval = deps.requestToolApproval ?? requestToolApproval;
  const _executeTool = deps.executeTool ?? executeTool;
  return async (name: string, args: unknown, sid?: string, agentId?: string): Promise<unknown> => {
    if (!sid) throw new Error('forgeax-core kernel: missing hostSessionId for host-tool bridge');
    // P1-9 一等工具化:ui_act_* 在信任闸**之前**反解回 ui_invoke(actionId),使权限
    // (per-action 闸)/审计/执行全程只认识 ui_invoke 一条路(闭合 union,不加新分支)。
    const fc = resolveFirstClassUiTool(sid, name);
    if (fc) {
      args = { actionId: fc.actionId, args: (args ?? {}) as Record<string, unknown> };
      name = 'ui_invoke';
    }
    // 审计同 `POST /:sid/kernel-tool`:单 start 计 durationMs,每个决策出口恰追加一行(append-only)。
    const start = Date.now();
    // 用本轮真实 agent(委派轮 = mochi 等)而非写死 defaultAgentPath:trustTier 求值、
    // requestToolApproval 卡片归属(agent→WS fan-out / owner)、executeTool 执行 context 都按它走。
    // 写死成 'forge' 会让被委派 agent 的权限卡错记到主 agent,turn 收尾的
    // denyPermissionsForSession(sid,'forge') 误杀其 pending,用户回答 resolve 不回去 → 卡死。
    const agentPath = agentId?.trim() || defaultAgentPath;
    const session = _getSessionManager().peek(sid) ?? (await _getSessionManager().open(sid));
    const agent = session.scheduler.getAgent(agentPath);
    if (!agent) {
      // agent 不在线 —— trustTier 尚未求得,与 sessions.ts 一致记 'unknown' / allow=false。
      appendToolAudit({ sid, agent: agentPath, tool: name, trustTier: 'unknown', allow: false, error: `agent '${agentPath}' not live in session`, durationMs: Date.now() - start, ts: start });
      throw new Error(`forgeax-core kernel: agent '${agentPath}' not live in session ${sid}`);
    }

    // 信任闸:own=full;imported=deny 危险集。权威 trustTier 按加载路径求(fail-closed)。
    let trustTier: 'own' | 'imported' = 'imported';
    try {
      trustTier = (await _loadAgentRecord(agentPath, { projectRoot: defaultProjectRoot() })).trustTier;
    } catch {
      /* fail-closed → imported */
    }
    // R2-08:imported 写禁但「该 session 绑定的 game 目录内」豁免。永久绑定(PR2)下豁免基准
    // 是 session 自己绑的 game(config.defaultDir 由路径派生),非全局 active game——绑 A、
    // active 切 B 时不会误判 A 自己的写。session 未绑则回落 active game。
    const projectRoot = defaultProjectRoot();
    const scopeGame = session.config?.defaultDir ?? getPathManager().resolveScope();
    // sid 供 ui_invoke 的 per-action capability 查表(manifest 缓存按 sid 存,见 trust-gate)。
    const decision = _checkKernelTool(trustTier, name, { args, projectRoot, activeGame: scopeGame, sid });
    tt('htb.decision', { name, agent: agentPath, sid, trustTier, outcome: decision.outcome, cap: decision.capability });
    if (decision.outcome === 'deny') {
      // 信任闸硬拒 —— 审计记录 allow=false。
      appendToolAudit({ sid, agent: agentPath, tool: name, trustTier, allow: false, error: decision.reason ?? `denied by trust tier: ${name}`, durationMs: Date.now() - start, ts: start });
      throw new Error(decision.reason ?? `denied by trust tier: ${name}`);
    }
    // ask:弹权限卡阻塞等用户(命中本会话 remember 直放);拒绝/超时 → 抛(fail-closed)。
    const delegateConfirmation =
      decision.outcome === 'ask' &&
      !isForgeaxBuiltinTool(name) &&
      !getHostTool(name)?.run &&
      _shouldDelegateHostToolConfirmation(name, agent.agentContext.tools.list());
    if (decision.outcome === 'ask' && !delegateConfirmation) {
      tt('htb.approval-wait', { name, agent: agentPath, sid, cap: decision.capability });
      const approved = await _requestToolApproval({
        eventBus: session.eventBus,
        sid,
        agent: agentPath,
        toolName: name,
        ...(decision.capability ? { capability: decision.capability } : {}),
        args,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      tt('htb.approval-result', { name, agent: agentPath, approved });
      if (!approved) {
        // 用户拒绝 —— 审计记录 allow=false。
        appendToolAudit({ sid, agent: agentPath, tool: name, trustTier, allow: false, error: 'denied by user', durationMs: Date.now() - start, ts: start });
        throw new Error(`denied by user: ${name}`);
      }
    }

    tt('htb.exec-start', { name, agent: agentPath });
    try {
      // 执行解析顺序:①内置 forgeax 工具(remember/memory_search/ui_*/echo)走宿主侧
      //   实现;②产品壳 seam 注入且带 run 的 host 工具(list_games/query_world/
      //   capture_frame,P1-7)走 `HostToolSpec.run`;③其余查 agent 的 kit 注册表。
      //   schema 都由 compose-turn-request 出墙。
      const seamTool = getHostTool(name);
      const builtinCtx = {
        projectRoot,
        agentId: agentPath,
        ...(scopeGame ? { game: scopeGame } : {}),
        eventBus: session.eventBus,
        sid,
      };
      const out = isForgeaxBuiltinTool(name)
        ? await runForgeaxBuiltinTool(name, (args ?? {}) as Record<string, unknown>, builtinCtx)
        : seamTool?.run
          ? await seamTool.run((args ?? {}) as Record<string, unknown>, hostToolRunCtx(builtinCtx))
          : await _executeTool(
              name,
              (args ?? {}) as Record<string, unknown>,
              agent.agentContext.tools.list(),
              agent.agentContext,
            );
      // 工具返回 `{error}` 形状 = 失败(与 `:sid/kernel-tool` 同口径:Unknown tool / 校验失败 /
      //   工具内 throw 都落此形状)。翻成 throw → 下方 catch 记**唯一**一行 ok:false 审计 +
      //   rethrow → RPC reject → 内核标 isError(而非 ok:true 夹 error,§5 fail-fast)。
      if (out && typeof out === 'object' && !Array.isArray(out) && 'error' in out) {
        const rawErr = (out as { error: unknown }).error;
        const errMsg = typeof rawErr === 'string' ? rawErr
          : rawErr instanceof Error ? rawErr.message
          : JSON.stringify(rawErr);
        throw new Error(errMsg);
      }
      tt('htb.exec-done', { name, agent: agentPath, ms: Date.now() - start });
      // 工具执行成功 —— allow=true / ok=true。
      appendToolAudit({ sid, agent: agentPath, tool: name, trustTier, allow: true, ok: true, durationMs: Date.now() - start, ts: start });
      return out;
    } catch (e) {
      tt('htb.exec-error', { name, agent: agentPath, ms: Date.now() - start, err: (e as Error).message });
      // 工具执行抛出 —— allow=true / ok=false,审计后照旧 rethrow。
      appendToolAudit({ sid, agent: agentPath, tool: name, trustTier, allow: true, ok: false, error: (e as Error).message, durationMs: Date.now() - start, ts: start });
      throw e;
    }
  };
}
