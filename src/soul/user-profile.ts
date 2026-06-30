/**
 * 全局用户画像（USER.md）—— "Agent 记住用户是谁"的稳定底座（open claw USER 层）。
 *
 * 与数字生命分层记忆的分工:
 *   - identity/traits/episodes = 关于**某个 agent** 的(每 agent 一份,落
 *     `.forgeax/souls/<agentId>/memory`);
 *   - USER.md = 关于**人(用户)** 的事实 —— 姓名/时区/语言/在做的项目/长期偏好。
 *     **全局一份、跨 agent 共享**,落 `<projectRoot>/.forgeax/user/USER.md`,
 *     每轮作为 bootstrap 注入每个 agent 的 stable 前缀。
 *
 * 写入是**按 key 去重 upsert**(确定性,无需二次 LLM reconcile):每条画像带一个
 * `<!-- k:<slug> -->` 标记,同 key 覆盖、新 key 追加。auto-extract 自动捕捉,
 * 用户也可在 Workbench「长期记忆」里手动编辑(会被下次 upsert 尊重)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HEADER =
  '# 用户画像\n\n> 由对话自动捕捉 + 可手动编辑。每条按 `key` 去重 upsert(末尾 `<!-- k:... -->` 是去重标记,勿删)。\n';

/** USER.md 所在目录(绝对路径)。 */
export function userProfileDir(projectRoot: string): string {
  return resolve(projectRoot, '.forgeax', 'user');
}

/** USER.md 绝对路径。 */
export function userProfilePath(projectRoot: string): string {
  return resolve(userProfileDir(projectRoot), 'USER.md');
}

/** 读 USER.md 全文;不存在 → ''。 */
export function readUserProfile(projectRoot: string): string {
  const p = userProfilePath(projectRoot);
  try {
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

/** 一条用户画像事实。 */
export interface UserFact {
  /** 短键/标题(去重 key 由此 slug 化),如 "时区" / "name" / "语言偏好"。 */
  name: string;
  /** 事实正文(单行;多行会被折成一行)。 */
  body: string;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'fact'
  );
}

const LINE_RE = /^- \*\*(.+?)\*\* — ([\s\S]*?)\s*<!-- k:([^\s]+) -->\s*$/;

/**
 * 把若干用户画像事实 upsert 进全局 USER.md(按 key 去重)。返回实际新增/变更条数。
 * 无变更则不写盘。
 */
export function upsertUserFacts(projectRoot: string, facts: UserFact[]): number {
  if (!facts.length) return 0;

  // 解析已有条目(保序 by key)。
  const map = new Map<string, { name: string; body: string }>();
  for (const line of readUserProfile(projectRoot).split('\n')) {
    const m = line.match(LINE_RE);
    if (m) map.set(m[3], { name: m[1].trim(), body: m[2].trim() });
  }

  let changed = 0;
  for (const f of facts) {
    const name = (f.name ?? '').trim();
    const body = (f.body ?? '').replace(/\s*\n+\s*/g, ' ').trim();
    if (!body) continue;
    const k = slug(name || body);
    const prev = map.get(k);
    if (!prev || prev.body !== body || prev.name !== (name || k)) {
      map.set(k, { name: name || k, body });
      changed++;
    }
  }
  if (changed === 0) return 0;

  const lines = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `- **${v.name}** — ${v.body} <!-- k:${k} -->`);
  const content = `${HEADER}\n${lines.join('\n')}\n`;

  mkdirSync(userProfileDir(projectRoot), { recursive: true });
  writeFileSync(userProfilePath(projectRoot), content, 'utf-8');
  return changed;
}
