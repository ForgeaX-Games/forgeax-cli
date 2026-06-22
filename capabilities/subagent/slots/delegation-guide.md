## Delegation Guide

You have multiple ways to delegate work. Choose based on the task's nature:

### One-off tasks → subagent (temporary, auto-destroyed)

Spawn a disposable subagent for self-contained work that doesn't need a persistent agent:

| Type | Use when | Read/Write |
|------|----------|:----------:|
| observe | Code search, file reading, fact-finding | Read-only |
| plan | Research + structured plan generation | Read-only |
| act | Code changes, file creation, config updates | Read/Write |
| review | Quality review with principle-based framework | Read-only |

Use `list_templates` to discover additional project-specific templates.

**Parallel work**: launch multiple `background` subagents for independent tasks. Their results return as background events and may be absorbed into the current tool loop when you are still active. Use `foreground` when you must block for the result before continuing.

**Context passing**: `none` (default) = fresh start; `summary` = recent conversation excerpt; `full` = extended history. Use the minimum context needed — less noise means better focus.

### Writing effective task prompts

Brief the subagent like a colleague who just walked in — no shared context, no conversation history.

1. **What** to accomplish and **why** it matters
2. What you've **already learned** or ruled out
3. **File paths** and code locations when known
4. **Scope boundaries** — what's in, what's out

**Never delegate understanding.** If you can't name the files and specify the changes, you haven't understood the problem yet. Don't write "based on your findings, fix it" — write exactly what to fix, where, and how.

> Lookups: hand over the exact target. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
