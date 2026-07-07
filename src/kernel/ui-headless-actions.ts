/** ui-headless-actions —— UI 语义操作层的 **cli 内置** headless handler 表(P1-8)。
 *
 *  UI 不在线时,`ui_invoke` 对 surface:'server'|'both' 的 action 回落宿主侧等价执行
 *  (forgeax-builtin-tools 的 ui_invoke case)。查找顺序:产品壳 seam(`hostUiActions`,
 *  见 orchestration-seams)优先,本表兜底——**本表只放编排层自有域**(session 域归
 *  cli),游戏域 handler 归产品壳注入,cli 保持业务无关。
 *
 *  硬约束(方案 §5,评审 2.6):handler 必须调与 UI run() **相同的内部实现**
 *  (SessionManager 即 /api/sessions 路由用的同一单例),不许长出第二份业务逻辑。
 */
import { getSessionManager } from '../core/session-manager';
import { createSessionWithBootstrap } from '../api/lib/session-create';
import type { HostUiActionHandler } from '../orchestration-seams';

const BUILTIN: HostUiActionHandler[] = [
  {
    // interface builtin-actions 的 'sessions.list'(capability:read, surface:both)。
    // UI run() 走 GET /api/sessions;这里调路由背后的同一 SessionManager.list()。
    actionId: 'sessions.list',
    run: () => {
      const rows = getSessionManager()
        .list()
        .map((s) => ({ sid: s.sid, displayName: s.displayName ?? null }));
      return { status: 'completed', stateDigest: rows };
    },
  },
  {
    // 'session.create'(write, both):与 POST /api/sessions 路由共用
    // createSessionWithBootstrap(SSOT,含入口 agent bootstrap)。
    actionId: 'session.create',
    run: async (args) => {
      const out = await createSessionWithBootstrap({
        ...(typeof args.displayName === 'string' ? { displayName: args.displayName } : {}),
        autoStart: true,
      });
      return { status: 'completed', stateDigest: { activeSid: out.sid, bootstrappedAgent: out.bootstrappedAgent } };
    },
  },
  {
    // 'session.close'(delete, both):与 DELETE /api/sessions/:sid 同一
    // SessionManager.delete(整目录抹除)。delete 类声明在闸上会先弹确认卡。
    actionId: 'session.close',
    run: async (args) => {
      const sid = typeof args.sid === 'string' ? args.sid : '';
      if (!sid) return { status: 'rejected', reason: 'session.close requires sid (string)' };
      await getSessionManager().delete(sid);
      return { status: 'completed', stateDigest: { closed: sid } };
    },
  },
];

/** 按 actionId 取 cli 内置 headless handler(seam 未命中时的兜底)。 */
export function getBuiltinHeadlessUiAction(actionId: string): HostUiActionHandler | undefined {
  return BUILTIN.find((h) => h.actionId === actionId);
}
