<!--
  Memory navigation guide — when and how to READ your memory.
  Writing is handled by auto_daily (automatic) and memory_curator (periodic curation prompt).
  MEMORY.md first 200 lines are auto-injected into your system prompt (memory-head section).
-->

<when-to-read>

**On wake / session start:**
1. Your MEMORY.md (first 200 lines) is already in context — check the `<core-memory>` section above
2. `memory_get(path="memories/daily/YYYY-MM-DD.md")` — what happened today so far
3. If MEMORY.md was truncated (see comment at end of core-memory), use `memory_get(path="MEMORY.md", startLine=201)` to read the rest

**On topic switch (MANDATORY — do NOT skip):**
When the user introduces a new topic, feature name, or concept — **before responding substantively**, run:
`memory_search(query=<keywords>, scope="all")` — check for prior context

This is the most frequently skipped step. Common failure mode: you "feel like" you know the topic and start responding from general knowledge, missing that there are prior discussions, design docs, or decisions already recorded in memory. **Search first, talk second.**

Trigger signals — any of these means you should search:
- User names a feature, system, or design ("sandbox权限", "权限隔离", "plan系统")
- User says "we discussed this before" / "之前有记录" / "你看看"
- User references a draft, plan, or past decision
- You're about to say "let me think about this" or ask user to elaborate — search memory first instead

**On uncertainty (error, unfamiliar config, unclear preference):**
1. `memory_search(query=<keywords>)` — locate relevant files
2. `memory_get(path=<hit>)` — read full content
3. If hit is `knowledge/skills/<id>` → `read_skill <id>` for latest SOP

**Before compaction:**
Ensure important context from current session is already in daily (auto_daily handles this, but verify if critical).

</when-to-read>

<memory-structure>

```
homes/{id}/
├── MEMORY.md                       ← permanent facts + knowledge index
│   ├── First 200 lines             ←   AUTO-INJECTED into system prompt
│   └── Beyond 200 lines            ←   requires memory_get to read
└── memories/
    ├── knowledge/                   ← topic graph ([[wikilinks]])
    │   └── skills/<skill-id>.md    ←   skill usage notes
    ├── daily/                       ← auto-generated session logs (by auto_daily)
    └── experience/                  ← problem→fix graph ([[wikilinks]])
```

| Layer | Content | File granularity | Lifecycle |
|-------|---------|-----------------|-----------|
| MEMORY.md (head) | Core identity, key facts, active goals, knowledge index | Single file, first 200 lines | Permanent, auto-injected |
| MEMORY.md (tail) | Secondary details, historical records | Single file, beyond line 200 | Permanent, read on demand |
| knowledge/ | Linked knowledge graph ([[wikilink]]) | One file per topic | Permanent |
| daily/ | Session activity logs (auto-generated) | One file per day | Daily |
| experience/ | Problem→fix experiences, linked to knowledge | One file per experience | Permanent |

**MEMORY.md organization rule:** Keep the most important content in the first 200 lines — identity, key facts, active goals, user preferences, and knowledge/experience indexes. Move historical details, completed project records, and verbose logs beyond line 200.

</memory-structure>

<tools-reference>

### memory_search
| Param | Type | Note |
|-------|------|------|
| query | string | Keywords or natural language |
| scope | `all` / `MEMORY` / `knowledge` / `daily` / `experience` | Default: all |
| mode | `auto` / `fts` / `semantic` | Default: auto |
| maxResults | number | Default: 8, max 50 |
| followLinks | boolean | Attach wikilink graph neighbors |

### memory_get
| Param | Type | Note |
|-------|------|------|
| path | string | Relative to `homes/{id}/` |
| withLinks | boolean | Attach backlinks/forward links |

</tools-reference>
