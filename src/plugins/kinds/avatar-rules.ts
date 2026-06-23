/**
 * Phase B2.5 — agent avatar state machine loader.
 *
 * 把 plugin <dir>/avatar/AVATAR.md (YAML frontmatter + markdown 表格) 解析成
 * 运行时可用的 AgentAvatarRules 对象, file 字段被规范化成 /api/files/raw?path=
 * 形式的相对 URL (项目根下的 packages/marketplace/plugins/<id>/avatar/<webm>).
 *
 * 见 ADR-0019 §Decision §3, §5.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import yaml from 'yaml';
import {
  AGENT_AVATAR_EVENTS,
  type AgentAvatarEvent,
  type AgentAvatarRules,
  type AgentAvatarState,
} from '@forgeax/types';
import { assetRoot } from '../../lib/asset-root';

const FRONTMATTER_RX = /^---\s*\n([\s\S]+?)\n---\s*\n([\s\S]*)$/;

/** 解析"| state | file | loop | fadeInMs | onEnd | onEndAfterMs |"形式的表格. */
function parseTable(body: string): Array<Partial<AgentAvatarState>> {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  // 跳过表头 + 分隔行.
  if (lines.length < 2) return [];
  const headerCells = lines[0]
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  const rows = lines.slice(2);
  const out: Array<Partial<AgentAvatarState>> = [];
  for (const line of rows) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < headerCells.length) continue;
    const row: Record<string, string> = {};
    for (let i = 0; i < headerCells.length; i++) {
      row[headerCells[i].toLowerCase()] = cells[i];
    }
    if (!row.state || !row.file) continue;
    const partial: Partial<AgentAvatarState> = {
      state: row.state,
      url: row.file, // resolveUrl 在 caller 里做; 这里先放裸文件名.
      loop: row.loop === undefined ? true : /^(true|1|yes)$/i.test(row.loop),
      fadeInMs: row.fadeinms ? Number(row.fadeinms) || 0 : 0,
    };
    if (row.onend) partial.onEnd = row.onend;
    if (row.onendafterms) partial.onEndAfterMs = Number(row.onendafterms) || undefined;
    out.push(partial);
  }
  return out;
}

export interface ParsedAvatarRules {
  rules: AgentAvatarRules | null;
  /** loader 暴露给上层 (KindLoadIssue) 的诊断信息. */
  issues: string[];
}

/** 给定 agent 的 manifest 所在目录 + 可选 rulesFile 字段, 返回 resolved rules.
 *  rulesFile 默认 "./avatar/AVATAR.md"; 自动找不到也不算错, 静默返回 null. */
export function loadAvatarRules(
  pluginDir: string,
  rulesFile: string | undefined,
): ParsedAvatarRules {
  const rel = rulesFile ?? './avatar/AVATAR.md';
  const abs = resolve(pluginDir, rel);
  if (!existsSync(abs)) {
    // 显式声明了 avatarSet 但文件不在 → 报告; 否则静默 (绝大多数 agent 不带 webm).
    if (rulesFile) {
      return { rules: null, issues: [`avatarSet.rulesFile not found: ${abs}`] };
    }
    return { rules: null, issues: [] };
  }
  let text: string;
  try {
    text = readFileSync(abs, 'utf-8');
  } catch (e) {
    return { rules: null, issues: [`cannot read ${abs}: ${(e as Error).message}`] };
  }
  const m = FRONTMATTER_RX.exec(text);
  if (!m) {
    return { rules: null, issues: [`${abs}: missing YAML frontmatter`] };
  }
  let fm: any;
  try {
    fm = yaml.parse(m[1]);
  } catch (e) {
    return { rules: null, issues: [`${abs}: YAML parse error: ${(e as Error).message}`] };
  }
  const issues: string[] = [];
  const tableRows = parseTable(m[2]);
  if (tableRows.length === 0) {
    return { rules: null, issues: [`${abs}: no state rows parsed from table`] };
  }

  const rootDir = assetRoot();
  const avatarDir = dirname(abs);
  // 把 file 字段 (相对 avatar dir 的裸文件名 e.g. "01_期待.webm")
  // 转成 URL: /api/files/raw?path=<assetRoot-relative>.
  const states: Record<string, AgentAvatarState> = {};
  for (const r of tableRows) {
    if (!r.state || !r.url) continue;
    const fileName = r.url;
    const filePath = resolve(avatarDir, fileName);
    if (!existsSync(filePath)) {
      issues.push(`${abs}: state "${r.state}" file missing: ${filePath}`);
      continue;
    }
    let urlPath: string;
    try {
      // /api/files/raw 路径白名单是 `packages/**` (resolveSafePath +
      // resolveReadPath fallback). assetRoot() 本身就是 packages/, 所以拼
      // `packages/` + 从 assetRoot 算出的相对路径.
      const relFromRoot = relative(rootDir, filePath);
      const queryPath = `packages/${relFromRoot}`;
      urlPath = `/api/files/raw?path=${encodeURIComponent(queryPath)}`;
    } catch {
      issues.push(`${abs}: cannot compute URL for ${filePath}`);
      continue;
    }
    states[r.state] = {
      state: r.state,
      url: urlPath,
      loop: r.loop ?? true,
      fadeInMs: r.fadeInMs ?? 0,
      ...(r.onEnd ? { onEnd: r.onEnd } : {}),
      ...(r.onEndAfterMs ? { onEndAfterMs: r.onEndAfterMs } : {}),
    };
  }
  if (Object.keys(states).length === 0) {
    return { rules: null, issues: [...issues, `${abs}: zero usable states`] };
  }

  // events: 只接受 universal event 枚举; 未知 key 报警但不阻断.
  const events: Partial<Record<AgentAvatarEvent, string>> = {};
  for (const [k, v] of Object.entries(fm?.events ?? {})) {
    if (!AGENT_AVATAR_EVENTS.includes(k as AgentAvatarEvent)) {
      issues.push(`${abs}: unknown event key "${k}" (allowed: ${AGENT_AVATAR_EVENTS.join(',')})`);
      continue;
    }
    if (typeof v !== 'string') {
      issues.push(`${abs}: event "${k}" must map to a state name`);
      continue;
    }
    if (!states[v]) {
      issues.push(`${abs}: event "${k}" → "${v}" but no such state row`);
      continue;
    }
    events[k as AgentAvatarEvent] = v;
  }

  // priority: state name → number.
  const priority: Record<string, number> = {};
  for (const [k, v] of Object.entries(fm?.priority ?? {})) {
    if (typeof v !== 'number') {
      issues.push(`${abs}: priority "${k}" must be a number`);
      continue;
    }
    priority[k] = v;
  }

  const defaultState = String(fm?.default ?? '');
  const fallbackState = String(fm?.fallback ?? defaultState);
  if (!states[defaultState]) {
    return {
      rules: null,
      issues: [...issues, `${abs}: default "${defaultState}" not in states`],
    };
  }
  if (!states[fallbackState]) {
    issues.push(`${abs}: fallback "${fallbackState}" not in states → using default`);
  }

  const rules: AgentAvatarRules = {
    default: defaultState,
    fallback: states[fallbackState] ? fallbackState : defaultState,
    events,
    priority,
    states,
  };
  return { rules, issues };
}

/** 用 file mtime 做 cache key, AVATAR.md 改了下次自动 reload. */
const cache = new Map<string, { mtime: number; parsed: ParsedAvatarRules }>();

export function loadAvatarRulesCached(
  pluginDir: string,
  rulesFile: string | undefined,
): ParsedAvatarRules {
  const abs = resolve(pluginDir, rulesFile ?? './avatar/AVATAR.md');
  let mtime = 0;
  try {
    mtime = statSync(abs).mtimeMs;
  } catch {
    // 文件不存在: 仍然 cache "null" 结果, 但 key 用 mtime=0 → 下次新建时 invalidate.
  }
  const hit = cache.get(abs);
  if (hit && hit.mtime === mtime) return hit.parsed;
  const parsed = loadAvatarRules(pluginDir, rulesFile);
  cache.set(abs, { mtime, parsed });
  return parsed;
}
