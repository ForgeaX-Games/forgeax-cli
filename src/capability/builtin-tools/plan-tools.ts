/**
 * Builtin plan-mode tool (②) — `ExitPlanMode`.
 *
 * plan 模式(只读强制)下唯一允许的「写」动作:模型用它声明「计划已成型,请求退出
 * plan 模式开始执行」。**出口有人类闸**(公理 §8 Human as Final Authority):
 * checkPermissions 恒返回 'ask',经 dispatch 的 askUser 缝交人类裁决——approve 后
 * call 才执行、sentinel 才产生;reject 则工具被 deny,权限模式停在 plan。
 *
 * 工具本身无副作用——只把一个 sentinel 打进结果 payload,由 CoreAgent loop 在收集
 * 工具结果后检测到该 sentinel,把 currentMode 恢复为进入 plan 前的模式
 * (镜像 message-tools 的 Handoff `HANDOFF_INTENT_KEY` 模式)。
 *
 * isReadOnly: () => true —— 这样它在 plan 模式的「只读强制」把闸下可被调用
 * (engine.isExitPlanTool 也额外显式豁免它,双保险)。豁免只是免 plan-deny,
 * 本工具 checkPermissions 的 'ask' 仍照常流经 engine ③→⑧ 生效。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool } from '../types';

export interface ExitPlanModeInput {
  /** 模型给出的执行计划(展示用;可选)。 */
  plan?: string;
}

export interface ExitPlanModeOutput {
  exited: boolean;
  plan?: string;
}

/**
 * ExitPlanMode 工具结果 payload 上携带的标记键 —— loop 据此检测「请求退出 plan 模式」。
 * 取此名以避免与一般工具结果字段撞车(镜像 HANDOFF_INTENT_KEY)。
 */
export const EXIT_PLAN_INTENT_KEY = '__exitPlanMode' as const;

/**
 * ExitPlanMode:plan 模式下声明计划成型、请求开始执行。结果 payload 带
 * EXIT_PLAN_INTENT_KEY,loop 检测到即把权限模式翻回 default。
 */
export function exitPlanModeTool(): AgentTool<ExitPlanModeInput, ExitPlanModeOutput> {
  return buildTool<ExitPlanModeInput, ExitPlanModeOutput>({
    name: 'ExitPlanMode',
    aliases: ['exit_plan_mode'],
    searchHint: 'exit plan mode and start executing the agreed plan',
    inputJSONSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The execution plan you intend to carry out.' },
      },
      additionalProperties: false,
    },
    maxResultSizeChars: 4_000,
    // 无外部副作用;声明只读以便在 plan 模式只读强制下可被调用。
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    // 出口人类闸(公理 §8):恒 'ask' —— approve 后 call 才跑、sentinel 才生效;
    //   reject → deny,停在 plan。显式 allow 规则(engine ⑦)可越过此 ask(持久授权)。
    checkPermissions: async (input) => ({
      behavior: 'ask',
      updatedInput: input,
      message: 'Agent requests to exit plan mode and start executing the plan.',
      decisionReason: { type: 'mode', mode: 'plan' },
    }),
    async call(input): Promise<{ data: ExitPlanModeOutput }> {
      return { data: { exited: true, plan: input?.plan } };
    },
    // sentinel 打进结果 payload,loop 在收集工具结果后恢复进入 plan 前的模式。
    mapResult: (o, id): CoreEvent => ({
      type: CoreEventType.ToolCallResult,
      payload: {
        toolUseId: id,
        isError: !o.exited,
        result: 'User approved the plan — exited plan mode; you may now execute it.',
        [EXIT_PLAN_INTENT_KEY]: true,
      },
      ts: Date.now(),
    }),
  });
}
