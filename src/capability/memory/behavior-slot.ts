/**
 * Memory behavior slot —— 注入「主 agent 怎么/何时用记忆」的行为提示(英文,静态、进稳定缓存前缀)。
 *
 * 对齐 cc `memdir.ts buildMemoryLines`:让**主 agent 在主 loop 内联**用 Write/Edit(或 `remember`
 * 工具)写记忆(= cc 内联派,天然吃缓存),并统一 taxonomy / 禁存 / 召回信任规则。与 cache-safe
 * fork 互补:主 agent 当下判断要记的内联写,fork 兜底没写到的(后台、缓存安全)。
 *
 * 与 `makeMemorySlot`(注 MEMORY.md 索引内容)分工:本 slot 只出**指令**,不含易变内容 → 缓存稳定
 * (勿在此渲染会变的记忆正文/日期)。Step8 的 trusting-recall / drift caveat 提示词侧也并在这里。
 * Boundary: 仅 import core-local 类型。
 */
import type { Slot } from '../types';
import { MEMORY_INDEX_FILE } from './scan';

export interface MemoryBehaviorSlotDeps {
  memoryDir: string;
}

/** 行为提示 slot(static)。memoryDir 是稳定路径,可进缓存前缀。 */
export function makeMemoryBehaviorSlot(deps: MemoryBehaviorSlotDeps): Slot {
  const dir = deps.memoryDir;
  const text = [
    '# Persistent memory',
    '',
    `You have a persistent, file-based memory system at \`${dir}\`. Build it up over time so future`,
    'conversations have context on who the user is, how they want to collaborate, and the work at hand.',
    'If the user explicitly asks you to remember something, save it now; to forget, remove that entry.',
    '',
    '## Types (closed taxonomy)',
    '- **user**: the user\'s role, goals, preferences, working style.',
    '- **feedback**: guidance on how to work (corrections AND confirmed approaches); include the *why*.',
    '- **project**: ongoing work/goals/constraints not derivable from code or git; convert relative dates to absolute.',
    '- **reference**: pointers to external resources (URLs, dashboards, tickets).',
    '',
    '## What NOT to save',
    'Code/architecture/file paths (read the code), git history (`git log`/`blame`), debugging recipes (the fix is',
    'in the code), anything already in CLAUDE.md/AGENTS.md, or ephemeral current-conversation state.',
    '',
    '## How to save (two steps)',
    'Step 1 — write each memory to its own `.md` file under the memory dir with frontmatter `name` / `description`',
    '/ `type` (one of user|feedback|project|reference). For feedback/project, structure the body as the rule/fact',
    'then **Why:** and **How to apply:** lines.',
    `Step 2 — add a one-line pointer in \`${MEMORY_INDEX_FILE}\` (the index, not a memory): \`- [Title](file.md) — one-line hook\`.`,
    `Never write memory content directly into \`${MEMORY_INDEX_FILE}\`. Organize by topic, not chronologically.`,
    'Check for an existing file before creating a new one — update rather than duplicate; delete memories that turn out wrong.',
    '',
    '## When to access',
    "Access memory when it seems relevant or the user references prior-conversation work; you MUST access it when",
    'asked to check/recall. If the user says to *ignore* memory, proceed as if it were empty — do not cite or apply it.',
    '',
    '## Before recommending from memory',
    'A memory naming a specific file/function/flag is a claim it existed *when written* — it may be renamed, removed,',
    'or never merged. Before acting on it: if it names a file path, check the file exists; if a function/flag, grep for',
    'it; verify before the user acts. "The memory says X exists" is not "X exists now." Memories are point-in-time',
    'observations, not live state — for *current* repo state prefer `git log` / reading the code over recalling a snapshot.',
  ].join('\n');

  return {
    name: 'memory-behavior',
    dynamic: false,
    render() {
      return text;
    },
  };
}
