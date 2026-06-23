/** agent-prefs —— 「卸载 agent」偏好的服务端镜像。
 *
 *  浏览器 localStorage 是 SSOT，PUT /api/prefs/uninstalled-agents 在每次切换时
 *  把列表落到 `<projectRoot>/.forgeax/prefs/uninstalled-agents.json`。需要在
 *  prompt 渲染 / list_subagents 工具里读到「用户卸载了哪些」的服务端代码同步
 *  调 readUninstalledAgentIds() —— 拿不到文件就当空数组（=全部已安装），fail-
 *  open 比 fail-closed 更安全：最差情况是 LLM 看到一个用户不想要的 agent 名字。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultProjectRoot } from './safe-path';

function prefsPath(): string {
  return join(defaultProjectRoot(), '.forgeax', 'prefs', 'uninstalled-agents.json');
}

export function readUninstalledAgentIds(): string[] {
  const p = prefsPath();
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { ids?: unknown }).ids)) {
      return ((parsed as { ids: unknown[] }).ids).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
    }
    return [];
  } catch {
    return [];
  }
}

export function writeUninstalledAgentIds(ids: string[]): void {
  const clean = Array.from(new Set(ids.filter((v) => typeof v === 'string' && v.length > 0))).sort();
  const p = prefsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ids: clean }, null, 2) + '\n', 'utf-8');
}
