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
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getActiveGame } from '../api/lib/active-game';
import { tt } from '../lib/turn-trace';

/** 与原生内核约定的 host 工具执行签名(结构化,不 import 内核包的类型)。
 *  `agentId` = 本轮真实发起工具的 agent(委派轮里即被委派方,如 mochi);缺省回落 defaultAgentPath。 */
export type HostExecuteToolFn = (name: string, args: unknown, sid?: string, agentId?: string) => Promise<unknown>;

/** in-process host-tool 桥:与 `POST /:sid/kernel-tool` 同一信任闸口(T-D),免 HTTP。 */
export function makeInProcessExecuteTool(defaultAgentPath = 'forge'): HostExecuteToolFn {
  return async (name: string, args: unknown, sid?: string, agentId?: string): Promise<unknown> => {
    if (!sid) throw new Error('forgeax-core kernel: missing hostSessionId for host-tool bridge');
    // 用本轮真实 agent(委派轮 = mochi 等)而非写死 defaultAgentPath:trustTier 求值、
    // requestToolApproval 卡片归属(agent→WS fan-out / owner)、executeTool 执行 context 都按它走。
    // 写死成 'forge' 会让被委派 agent 的权限卡错记到主 agent,turn 收尾的
    // denyPermissionsForSession(sid,'forge') 误杀其 pending,用户回答 resolve 不回去 → 卡死。
    const agentPath = agentId?.trim() || defaultAgentPath;
    const session = getSessionManager().peek(sid) ?? (await getSessionManager().open(sid));
    const agent = session.scheduler.getAgent(agentPath);
    if (!agent) throw new Error(`forgeax-core kernel: agent '${agentPath}' not live in session ${sid}`);

    // 信任闸:own=full;imported=deny 危险集。权威 trustTier 按加载路径求(fail-closed)。
    let trustTier: 'own' | 'imported' = 'imported';
    try {
      trustTier = (await loadAgentRecord(agentPath, { projectRoot: defaultProjectRoot() })).trustTier;
    } catch {
      /* fail-closed → imported */
    }
    // R2-08:imported 写禁但「当前游戏目录内」豁免 —— 传 args/projectRoot/activeGame 供作用域判定。
    const projectRoot = defaultProjectRoot();
    const decision = checkKernelTool(trustTier, name, { args, projectRoot, activeGame: getActiveGame(projectRoot) });
    tt('htb.decision', { name, agent: agentPath, sid, trustTier, outcome: decision.outcome, cap: decision.capability });
    if (decision.outcome === 'deny') throw new Error(decision.reason ?? `denied by trust tier: ${name}`);
    // ask:弹权限卡阻塞等用户(命中本会话 remember 直放);拒绝/超时 → 抛(fail-closed)。
    if (decision.outcome === 'ask') {
      tt('htb.approval-wait', { name, agent: agentPath, sid, cap: decision.capability });
      const approved = await requestToolApproval({
        eventBus: session.eventBus,
        sid,
        agent: agentPath,
        toolName: name,
        ...(decision.capability ? { capability: decision.capability } : {}),
        args,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      tt('htb.approval-result', { name, agent: agentPath, approved });
      if (!approved) throw new Error(`denied by user: ${name}`);
    }

    tt('htb.exec-start', { name, agent: agentPath });
    const _t0 = Date.now();
    try {
      const out = await executeTool(
        name,
        (args ?? {}) as Record<string, unknown>,
        agent.agentContext.tools.list(),
        agent.agentContext,
      );
      tt('htb.exec-done', { name, agent: agentPath, ms: Date.now() - _t0 });
      return out;
    } catch (e) {
      tt('htb.exec-error', { name, agent: agentPath, ms: Date.now() - _t0, err: (e as Error).message });
      throw e;
    }
  };
}
