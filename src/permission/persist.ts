/**
 * 权限规则的项目级持久化(PERM)—— always-allow 规则落 `<cwd>/.forgeax/permissions.json`。
 *
 * 动机:TUI「总是允许」原本只 push 进进程内存的 rules(useAgent 的可变对象),
 *   重启即失忆。此模块把 allow 规则落盘到项目目录,启动时读回,做到跨会话记住。
 *
 * 文件形状(向前兼容,未知字段忽略):
 *   { "version": 1, "allow": [ { "toolName": "bash", "content"?: "git *" }, ... ] }
 *
 * 只持久化 **allow** 桶(用户显式「总是允许」的授予)。deny/ask 归策略/安全,
 *   不由 TUI 交互写盘。toolName 必须是 **canonical 真名**(调用方负责先解析别名)。
 *
 * fail-safe:读失败/形状非法 → 返回空数组(等同无持久化规则,绝不放宽权限);
 *   写失败 → 吞掉(不阻塞聊天,与 checkpoint 同款容错)。
 *
 * Boundary: 只 import 本目录 rules 类型 + node:。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PermissionRule } from './rules';

const FILE_VERSION = 1;

/** 持久化文件里的一条 allow 规则(behavior 恒为 allow,不落盘)。 */
interface PersistedRule {
  toolName: string;
  content?: string;
}

/** `<cwd>/.forgeax/permissions.json` 的绝对路径。 */
export function permissionsFilePath(cwd: string): string {
  return join(cwd, '.forgeax', 'permissions.json');
}

/** 读回项目级 always-allow 规则。任何异常 → [](fail-safe,不放宽权限)。 */
export function loadAllowRules(cwd: string): PermissionRule[] {
  try {
    const file = permissionsFilePath(cwd);
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (raw == null || typeof raw !== 'object') return [];
    const allow = (raw as { allow?: unknown }).allow;
    if (!Array.isArray(allow)) return [];
    const out: PermissionRule[] = [];
    for (const item of allow) {
      if (item == null || typeof item !== 'object') continue;
      const toolName = (item as { toolName?: unknown }).toolName;
      if (typeof toolName !== 'string' || toolName.length === 0) continue;
      const content = (item as { content?: unknown }).content;
      out.push({
        toolName,
        behavior: 'allow',
        source: 'project-permissions',
        ...(typeof content === 'string' && content.length > 0 ? { content } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 把当前 allow 规则集写回项目文件。写失败 → 吞掉(不阻塞交互)。
 *  只落 source !== 内置策略的用户授予是调用方的取舍;此处原样序列化传入的 allow。 */
export function saveAllowRules(cwd: string, allow: ReadonlyArray<PermissionRule>): void {
  try {
    const file = permissionsFilePath(cwd);
    mkdirSync(dirname(file), { recursive: true });
    const persisted: PersistedRule[] = allow.map((r) =>
      r.content !== undefined ? { toolName: r.toolName, content: r.content } : { toolName: r.toolName },
    );
    // 去重(toolName+content 相同视为同一条),稳定顺序。
    const seen = new Set<string>();
    const deduped = persisted.filter((p) => {
      const key = `${p.toolName}\u0000${p.content ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const body = JSON.stringify({ version: FILE_VERSION, allow: deduped }, null, 2);
    writeFileSync(file, `${body}\n`, 'utf8');
  } catch {
    // fail-safe:落盘失败不影响本次会话内的内存规则。
  }
}
