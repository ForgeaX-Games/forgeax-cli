// Agent 命名规范 —— 所有界面统一成「中文职能·英文名」+ 灰字「英文职能」。
//
// 数据来源是 plugin 的 card：card.cnTitle(中文职能) / card.name(英文名/人名) /
// card.enTitle(英文职能)。两个 API（/api/workbench/agents 与 /api/bus/plugins）
// 都用这里算出的 { title, sub }，把「格式决策」收敛到一处，避免前端各处各自拼。
//
// 退化规则（缺字段时仍可读）：
//   - 有 cnTitle + 英文名 → title = "中文职能·英文名"，sub = 英文职能
//   - 只有 cnTitle        → title = 中文职能
//   - 都没有              → title = fallback（本地化短名 / id），sub = 英文职能(若有)
// 没有「英文名」的功能型 agent（如「2D 角色设计师」）刻意不填 cnTitle，于是
// title 直接退回 fallback（中文职能本身），sub 显示英文职能 —— 两行但无人名。

export interface AgentNaming {
  /** 主标题：「中文职能·英文名」或退化形态。 */
  title: string;
  /** 副标题（灰字）：英文职能；无则空串。 */
  sub: string;
}

export interface AgentNamingInput {
  /** 英文名 / 人名（已解析为单串，优先英文），如 "Iori"。无人名时传空/undefined。 */
  personName?: string;
  /** 中文职能，如「核心玩法师」。 */
  cnTitle?: string;
  /** 英文职能，如 "Gameplay Pillar Designer"。 */
  enTitle?: string;
  /** 无结构化命名时的兜底标题（本地化短名 / id）。 */
  fallback: string;
}

export function computeAgentNaming(
  input: AgentNamingInput,
  lang: 'zh' | 'en' = 'zh',
): AgentNaming {
  const cn = input.cnTitle?.trim() || undefined;
  const pn = input.personName?.trim() || undefined;
  const en = (input.enTitle ?? '').trim();

  if (lang === 'en') {
    const title = pn ?? en ?? input.fallback;
    const sub = pn && en ? en : (cn && title !== cn ? cn : '');
    return { title, sub };
  }

  const title = cn && pn ? `${cn}·${pn}` : (cn ?? pn ?? input.fallback);
  return { title, sub: en };
}

/** 从 i18n 名字结构里取英文名（优先 en，回退 zh）。 */
export function pickPersonName(name: { zh?: string; en?: string } | string | undefined): string {
  if (!name) return '';
  if (typeof name === 'string') return name;
  return name.en ?? name.zh ?? '';
}
