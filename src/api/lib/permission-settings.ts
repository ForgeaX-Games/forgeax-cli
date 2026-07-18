/**
 * settings.permissions → 编排层规则集 loader(046 楔子1-补 + 楔子3)。
 *
 * 读分层 `.forgeax` settings(user `~/.forgeax/settings.json` < project
 * `<projectRoot>/.forgeax/settings.json` < local `settings.local.json`)的
 * `permissions.{deny,ask,allow}: string[]`(cc 同款 `Bash(git *)` 语法),给两处消费:
 *   - `kernel/trust-gate.ts` `checkKernelTool`:settings 规则叠加在 trustTier 基线上
 *     (host-routed 工具,楔子1-补);
 *   - `api/sessions.ts` 权限回执端(`/:sid/permission-request`)+ 外部内核 hook 决策端
 *     (`/:sid/hook-gate`,cc/codex/cursor 的 PreToolUse/hooks 同步回调,楔子3)。
 *
 * SSOT:规则模型/解析/匹配 = `@forgeax/types`(`permission-rules.ts`,自 core 上移的
 * 同一份实现);本文件只做「读文件 + 分层合并 + 缓存」。与 core `cli/settings.ts` 的
 * mergeRead 对齐的合并语义里,permissions 桶是数组 → **set-union**(各层 deny 全部生效,
 * 高层不能静默吞掉低层的 deny;这也是 cc 的分层语义)。
 *
 * fail-safe(§5/§9):文件缺失/JSON 非法/形状非法 → 该层当空,永不抛;规则条目非法
 * 由共享 `rulesFromPermissionsSetting` 丢弃(不当成授予)。
 *
 * 缓存:按 (路径, mtimeMs) 三文件签名缓存,签名变了才重读——闸在每次工具调用上,
 * 不能每次 stat+read 三个文件以外还重复 parse。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import {
  matchRule,
  normalizeRules,
  rulesFromPermissionsSetting,
  type PermissionRule,
  type PermissionRuleSet,
} from '@forgeax/types';

/** 分层来源(低→高)。permissions 桶做 set-union,层序只影响 source 标注。
 *  user 层基准 = `$HOME`(POSIX 语义,Node os.homedir 同口径;bun 的 homedir()
 *  不读运行时改写的 $HOME → 显式先看 env,测试才能封闭重定向)。 */
function settingsPaths(projectRoot: string): Array<{ path: string; source: string }> {
  const home = process.env.HOME || homedir();
  return [
    { path: resolve(home, '.forgeax', 'settings.json'), source: 'user' },
    { path: resolve(projectRoot, '.forgeax', 'settings.json'), source: 'project' },
    { path: resolve(projectRoot, '.forgeax', 'settings.local.json'), source: 'local' },
  ];
}

interface CacheEntry {
  signature: string;
  rules: PermissionRuleSet;
}

const cache = new Map<string, CacheEntry>();

/** 读一层 settings 的 permissions 段(缺失/非法 → undefined,fail-safe)。 */
function readPermissionsSection(path: string): unknown {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>).permissions;
  } catch {
    return undefined;
  }
}

/** (path,mtimeMs) 三文件签名;文件不存在记 `-`(出现/消失也会翻新签名)。 */
function signatureOf(paths: Array<{ path: string }>): string {
  return paths
    .map(({ path }) => {
      try {
        return `${path}:${statSync(path).mtimeMs}`;
      } catch {
        return `${path}:-`;
      }
    })
    .join('|');
}

/** 桶级 set-union 合并(按 `toolName|content|behavior` 去重,保序:低层在前)。 */
function unionRules(sets: PermissionRuleSet[]): PermissionRuleSet {
  const out: PermissionRuleSet = { deny: [], ask: [], allow: [] };
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    const seen = new Set<string>();
    for (const s of sets) {
      for (const r of s[behavior]) {
        const key = `${r.toolName}|${r.content ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out[behavior].push(r);
      }
    }
  }
  return out;
}

/**
 * 载出分层合并后的 settings 权限规则集(带 mtime 缓存)。
 * `projectRoot` 缺省 = `defaultProjectRoot()`(与 sessions.ts 的 scope 口径一致)。
 * 无任何 settings / 无 permissions 段 → 三空桶(所有调用方零行为变化)。
 */
export function loadSettingsPermissionRules(projectRoot: string = defaultProjectRoot()): PermissionRuleSet {
  const paths = settingsPaths(projectRoot);
  const signature = signatureOf(paths);
  const hit = cache.get(projectRoot);
  if (hit && hit.signature === signature) return hit.rules;

  const layers: PermissionRuleSet[] = [];
  for (const { path, source } of paths) {
    const perms = readPermissionsSection(path);
    if (perms === undefined) continue;
    layers.push(rulesFromPermissionsSetting(perms, `settings(${source}).permissions`));
  }
  const rules = normalizeRules(layers.length ? unionRules(layers) : undefined);
  cache.set(projectRoot, { signature, rules });
  return rules;
}

/** 测试用:清空缓存(mtime 粒度在快速写文件的测试里不可靠)。 */
export function clearSettingsPermissionRulesCache(): void {
  cache.clear();
}

/** 规则的人读标签(决策 reason / 审计用),如 `settings(project).permissions.deny "Bash(rm *)"`。 */
export function ruleLabel(rule: PermissionRule): string {
  const shape = rule.content !== undefined ? `${rule.toolName}(${rule.content})` : rule.toolName;
  return rule.source ? `${rule.source} "${shape}"` : `"${shape}"`;
}

/** settings 规则的独立求值(deny > ask > allow;不含 tier 基线)。给权限回执端
 *  (`/:sid/permission-request`)与外部内核 hook 决策端(`/:sid/hook-gate`)用——
 *  外部内核**内置**工具跑在其子进程里,tier 闸管不到,规则是唯一声明面。
 *  未命中 → undefined(调用方走原有流程,零行为变化)。 */
export function evaluateSettingsRules(
  rules: PermissionRuleSet,
  toolName: string,
  input: unknown,
): { behavior: 'deny' | 'ask' | 'allow'; rule: PermissionRule } | undefined {
  const deny = matchRule(rules.deny, toolName, input);
  if (deny) return { behavior: 'deny', rule: deny };
  const ask = matchRule(rules.ask, toolName, input);
  if (ask) return { behavior: 'ask', rule: ask };
  const allow = matchRule(rules.allow, toolName, input);
  if (allow) return { behavior: 'allow', rule: allow };
  return undefined;
}
