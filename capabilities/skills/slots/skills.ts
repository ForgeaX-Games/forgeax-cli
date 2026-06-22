import type { SlotFactory } from "#src/capability/slot/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { createSkillsSummarySlot } from "../lib/skills-loader.js";

/**
 * skills slot 工厂。
 * 激活路径：Scheduler → SlotLoader → slots/skills.ts → 自定义扫盘逻辑。
 */
const create: SlotFactory = (ctx) =>
  createSkillsSummarySlot(
    ctx.pathManager,
    ctx.agentId,
    () => ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.CURRENT_DIR) as string | undefined,
  );

export default create;
