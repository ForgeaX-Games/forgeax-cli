/**
 * settings.permissions → PermissionRuleSet loader(楔子1 · 任务 046)。
 *
 * 把分层 settings(`getMergedSettings`,user<project<local)里的
 *   `permissions.{deny,ask,allow}: string[]`(cc 同款 `Bash(git *)` 语法)
 * 转成 engine 消费的 `PermissionRuleSet`,让「在配置里写一条 deny」对
 * forgeax-core(独立 CLI/TUI + Studio-经-sidecar)真正生效——引擎决策顺序
 * ① deny > ② ask > ⑦ allow(见 permission/engine.ts)。
 *
 * SSOT(046 楔子1-补后):`permissions` 段的解析(`rulesFromPermissionsSetting`)
 * 与规则模型一同上移到 `@forgeax/types`,cli 编排层读同一份 settings 时复用同一
 * 解析(两侧读法必然一致);本文件只余「getMergedSettings → 共享解析」的接线,
 * 并原名 re-export 保持 core 内 import 位点与单测零改动。
 * fail-safe(§5):非对象 permissions / 非数组桶 → 空桶;非字符串条目、形状非法
 *   (`parseRuleString` 返回 null)→ 丢弃该条(不当成授予)。
 *
 * Boundary(HOST 层):可 import 机制层 `../permission/rules` + 同层 `./settings`。
 */
import { rulesFromPermissionsSetting, type PermissionRuleSet } from '../permission/rules';
import { coercePermissionMode } from '../permission/inspect';
import type { PermissionMode } from '../permission/engine';
import { getMergedSettings } from './settings';

export { rulesFromPermissionsSetting };

/**
 * 从分层合并的 settings 读出 `permissions` 段并转成 `PermissionRuleSet`。
 * `cwd` 决定 project/local settings 的解析基准(默认 `process.cwd()`,与 host-context
 * 读 hooks 同口径)。settings 缺失/无 permissions → 三空桶(不改变默认 tier 行为)。
 */
export function loadPermissionRulesFromSettings(cwd: string = process.cwd()): PermissionRuleSet {
  return rulesFromPermissionsSetting(getMergedSettings(cwd).permissions);
}

// ── settings.permissions.defaultMode(同名同语义:启动初始权限模式)──

/** defaultMode 解析结果的三态:未配置(安静回退 default)/ 合法 / 配置了但非法
 *  (由 CLI 启动 boundary 决定是否警告后回退;本模块不打印)。 */
export type DefaultPermissionModeSetting =
  | { kind: 'unset' }
  | { kind: 'valid'; mode: PermissionMode }
  | { kind: 'invalid'; value: unknown };

/**
 * 解析 settings 的 `permissions.defaultMode`(未知形状 → 结构化三态)。纯函数,永不抛。
 * 校验复用 `coercePermissionMode`(与 /permissions、--permission-mode 同一份合法值真相)。
 */
export function parseDefaultModeFromPermissionsSetting(perms: unknown): DefaultPermissionModeSetting {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return { kind: 'unset' };
  const obj = perms as Record<string, unknown>;
  if (!('defaultMode' in obj)) return { kind: 'unset' };
  const mode = coercePermissionMode(obj.defaultMode);
  return mode ? { kind: 'valid', mode } : { kind: 'invalid', value: obj.defaultMode };
}

/** 从分层合并的 settings 读出 defaultMode(user<project<local,与规则桶同口径)。 */
export function loadDefaultPermissionModeFromSettings(
  cwd: string = process.cwd(),
): DefaultPermissionModeSetting {
  return parseDefaultModeFromPermissionsSetting(getMergedSettings(cwd).permissions);
}
