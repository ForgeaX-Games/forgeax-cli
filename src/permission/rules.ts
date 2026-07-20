/**
 * Permission rule model (PERM) — **SSOT 已上移**(046 楔子1-补)。
 *
 * 实现现活在共享契约包 `@forgeax/types`(`permission-rules.ts`):cli 编排层
 * (trust-gate settings 叠加 + 外部内核 hook 决策端点)与 core in-core engine
 * 要做同一套 `Bash(git *)` 结构感知匹配,而 cli 不依赖 core → 模型+匹配器上移,
 * 本文件只余 re-export(原 core 内十余个 import 位点 + 全部单测零改动)。
 *
 * 语义(shell 结构感知 E-01 / fail-closed / MCP server 级前缀)见
 * `@forgeax/types` 源头文档;core 侧行为不变。
 */
export {
  matchGlob,
  matchRule,
  normalizeRules,
  parseRuleString,
  ruleApplies,
  extractRuleContent,
  rulesFromPermissionsSetting,
  type PermissionRule,
  type PermissionRuleSet,
  type PermissionRuleBehavior,
} from '@forgeax/types';
