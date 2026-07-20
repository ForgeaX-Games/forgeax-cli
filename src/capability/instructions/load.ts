/**
 * 指令装载编排 —— 发现 → @import 展开 → rules 无条件装载 → 拼成单段 slot 文本。
 *
 * 组装口径:
 *   - 指令文件(AGENTS.md / CLAUDE.md,各层)整文件 `@import` 展开后原样收(不剥 frontmatter,
 *     指令文件通常无 frontmatter)。
 *   - rules(`.forgeax/rules` / `.claude/rules`)复用 skill 的 frontmatter 解析器判 `paths:`:
 *     **无 `paths:` → 无条件装载**(优先级同 CLAUDE.md);**带 `paths:` → 跳过**(条件激活留 T7,
 *     发现/解析层已在此复用,T7 只补 glob 匹配开关)。rule 正文同样 `@import` 展开。
 *   - 每个来源包成 `Contents of <abs> (<label>):\n<body>` 块(对齐 CC claudeMd 呈现),
 *     用空行分隔;全空 → 返回空串(slot 本轮不注入)。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseFrontmatter, toSkillMeta } from '../skill/frontmatter';
import { discoverInstructions, type InstructionDirs } from './discover';
import { expandImports, loadAndExpand } from './import';

export interface LoadInstructionsResult {
  /** 拼好的 slot 正文('' = 无指令,slot 不注入)。 */
  text: string;
  /** 收进正文的来源绝对路径(可观测 / 单测断言)。 */
  sources: string[];
}

/** 段头 + 引导语(静态,进稳定缓存前缀)。 */
const HEADER =
  '# Project & user instructions\n\n' +
  'The following AGENTS.md / CLAUDE.md files and rules describe how to work in this ' +
  'project and with this user. Treat them as authoritative instructions.';

/** 装载并组装分层指令(见文件头)。 */
export function loadInstructions(dirs: InstructionDirs): LoadInstructionsResult {
  const readFile = dirs.readFile ?? ((abs: string) => readFileSync(abs, 'utf8'));
  const { files, rules } = discoverInstructions(dirs);
  const blocks: string[] = [];
  const sources: string[] = [];

  for (const f of files) {
    const body = loadAndExpand(f.path, readFile).trim();
    if (!body) continue;
    blocks.push(`Contents of ${f.path} (${f.label}):\n${body}`);
    sources.push(f.path);
  }

  for (const r of rules) {
    let raw: string;
    try {
      raw = readFile(r.path);
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    // 复用 skill 的 paths 语义:meta.paths 非空 = 条件激活(T7)→ 本 PR 跳过;
    // 无 paths(含 match-all `**`)= 无条件装载。
    const meta = toSkillMeta(frontmatter, body, r.path);
    if (meta.paths) continue;
    const visited = new Set<string>([resolve(r.path)]);
    const expanded = expandImports(body, dirname(r.path), { visited }).trim();
    if (!expanded) continue;
    blocks.push(`Contents of ${r.path} (${r.label}):\n${expanded}`);
    sources.push(r.path);
  }

  if (blocks.length === 0) return { text: '', sources: [] };
  return { text: `${HEADER}\n\n${blocks.join('\n\n')}`, sources };
}
