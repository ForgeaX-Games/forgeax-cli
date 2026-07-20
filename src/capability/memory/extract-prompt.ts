/**
 * 扁平形态的提取提示词 + 写闸门控 —— 供 cache-safe fork(runForkedAgent)消费。
 *
 * 对齐 cc `services/extractMemories/prompts.ts`(扁平四类版):
 *   - opener:「acting as memory extraction subagent / 只用最近 ~N 条 / 别再 grep 验证 /
 *     turn1 并行 Read、turn2 并行 Write·Edit、勿跨轮交错」;
 *   - 预注入已有 manifest(「先查能更新就别新建」);
 *   - 四类 taxonomy(user/feedback/project/reference)+ what-not-to-save + how-to-save 两步。
 *
 * fork 用**真实 Read/Write/Edit 工具**内联写(故能先读已有去重),写闸把 Write/Edit 锁在 memory 目录内。
 * Boundary: 仅 core 相对 import。
 */
import { isAutoMemPath } from './tools';
import { MEMORY_INDEX_FILE } from './scan';

/** 英文提取指令(作 fork 尾部追加的唯一一条 user message)。`memoryDir` 是写盘根(绝对路径)。 */
export function buildExtractInstruction(memoryDir: string, manifest: string, recentMessageCount: number): string {
  const existing = manifest.trim()
    ? `\n\n## Existing memory files\n\n${manifest}\n\nCheck this list first — update an existing file rather than creating a duplicate.`
    : '';
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${recentMessageCount} messages of the conversation above and update your persistent memory accordingly.`,
    '',
    `Your memory directory is \`${memoryDir}\`. Write all memory files under it (absolute paths).`,
    '',
    `Available tools: Read, Grep, Glob (read-only), and Write/Edit for paths inside the memory directory only. All other tools are denied.`,
    '',
    `You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 — issue all Reads in parallel for every file you might update; turn 2 — issue all Write/Edit calls in parallel. Do not interleave reads and writes across turns.`,
    '',
    `You MUST only use content from the recent messages to update memory. Do NOT grep source files, read code, or run git to verify — just record durable facts.`,
    '',
    `If the user explicitly asked you to remember something, save it. If they asked you to forget something, remove that entry.`,
    existing,
    '',
    '## Types of memory (closed taxonomy)',
    '- **user**: durable facts about the user — role, goals, preferences, working style.',
    '- **feedback**: guidance on how to work (corrections AND confirmed approaches); include the *why*.',
    '- **project**: ongoing work/goals/constraints not derivable from code or git; convert relative dates to absolute.',
    '- **reference**: pointers to external resources (URLs, dashboards, tickets).',
    '',
    '## What NOT to save',
    '- Code patterns, conventions, architecture, file paths, project structure — derivable by reading the code.',
    '- Git history / who-changed-what — `git log`/`blame` are authoritative.',
    '- Debugging solutions / fix recipes — the fix is in the code.',
    '- Anything already in CLAUDE.md / AGENTS.md.',
    '- Ephemeral task state / current-conversation context.',
    '',
    '## How to save (two steps)',
    'Step 1 — write each memory to its own file (e.g. `user_role.md`, `feedback_testing.md`) with frontmatter:',
    '```markdown',
    '---',
    'name: {{short-slug}}',
    'description: {{one-line — used to decide relevance later}}',
    'type: {{user|feedback|project|reference}}',
    '---',
    '',
    '{{the memory; for feedback/project add **Why:** and **How to apply:** lines}}',
    '```',
    `Step 2 — add a one-line pointer in \`${MEMORY_INDEX_FILE}\` (the index, not a memory): \`- [Title](file.md) — one-line hook\`. Never write memory content directly into \`${MEMORY_INDEX_FILE}\`.`,
    '',
    '- Organize by topic, not chronologically. Update/remove memories that turn out wrong. Do not write duplicates.',
    'Return nothing special — your file writes ARE the result. An empty result (no writes) is correct when nothing is worth persisting.',
  ].join('\n');
}

/**
 * 周期蒸馏指令(对齐 cc `/dream`:治"只增不并"的碎片膨胀)。让 fork 通读 memory 目录,
 * **合并重复 / 删陈旧 / 整理索引**——纯维护,不引入新事实。`memoryDir` 是写盘根(绝对路径)。
 */
export function buildConsolidateInstruction(memoryDir: string, manifest: string): string {
  return [
    `You are now acting as the memory consolidation subagent. Tidy the existing persistent memory — do NOT add new facts from the conversation.`,
    '',
    `Your memory directory is \`${memoryDir}\`. You may Read/Grep/Glob it and Write/Edit files **inside it only**.`,
    '',
    '## Current memory index',
    manifest.trim() || '(empty)',
    '',
    '## Do',
    '- **Merge duplicates / near-duplicates**: combine memories about the same topic into one file; delete the redundant ones.',
    '- **Drop outdated / contradicted memories** (or fold the still-true part into a fresher file).',
    '- **Keep the closed taxonomy** (user|feedback|project|reference) and each file\'s frontmatter accurate.',
    '- **Rebuild the index pointers** in `MEMORY.md` so each surviving file has exactly one one-line entry.',
    '',
    '## Do NOT',
    '- Invent new memories, or pull facts from the conversation (that is the extraction subagent\'s job).',
    '- Touch anything outside the memory directory.',
    '',
    'Efficient strategy: turn 1 — Read all files you may merge; turn 2 — Write the merged files + delete-by-overwrite the index. Your file writes ARE the result.',
  ].join('\n');
}

/**
 * 写闸门控(canUseTool):放行 Read/Grep/Glob;Write/Edit 仅当 file_path 落在 memoryDir 内
 * 且非 MEMORY.md 索引(索引由 host rebuildIndex 重建);其余一律拒。对齐 cc createAutoMemCanUseTool。
 */
export function makeMemoryDirCanUseTool(memoryDir: string): (toolName: string, input: unknown) => boolean {
  // 同时认 canonical(core 工具名)+ PascalCase 别名(模型可能发任一)。
  const READONLY = new Set(['Read', 'read_file', 'Grep', 'grep', 'Glob', 'glob']);
  const WRITE = new Set(['Write', 'write_file', 'Edit', 'edit_file']);
  return (toolName: string, input: unknown): boolean => {
    if (READONLY.has(toolName)) return true;
    if (WRITE.has(toolName)) {
      const fp = input && typeof input === 'object' && 'file_path' in input ? (input as { file_path: unknown }).file_path : undefined;
      if (typeof fp !== 'string') return false;
      if (!isAutoMemPath(memoryDir, fp)) return false;
      if (fp.endsWith(`/${MEMORY_INDEX_FILE}`)) return true; // 允许写索引(模型按提示 Step2 更新)
      return true;
    }
    return false;
  };
}
