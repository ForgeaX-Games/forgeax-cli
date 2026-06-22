/** @desc Memory curator plugin — day-boundary full compaction + curation trigger */

import type { PluginSource } from "#src/capability/plugin/types.js";
import type { AgentContext } from "#src/core/types.js";
import { fullCompact } from "#src/context-window/summary-compaction.js";

const TEAMBOARD_KEY = "memory_curator:lastDate";
const POLL_INTERVAL_MS = 60_000;
const QUIET_PERIOD_MS = 30 * 60 * 1000;

function todayStr(tz: string): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz });
}

function buildPrompt(lastDate: string, today: string, compacted: boolean): string {
  const compactionNotice = compacted
    ? `<compaction-notice>
A full session compaction was just performed. Your conversation history has been
compressed into a single summary above. Your detailed memory of past events is LIMITED.
The daily log files on disk contain the COMPLETE record of what happened.
You MUST read them carefully — they are your primary source of truth, not your recall.
</compaction-notice>

`
    : "";

  return `<memory-curation last="${lastDate}" now="${today}">

${compactionNotice}<workflow>
<step n="0" name="memory-recovery"${compacted ? ' critical="true"' : ''}>
BEFORE doing any extraction or organization, restore your situational awareness:

1. memory_get(path="MEMORY.md")
   → Re-read your identity, active goals, key facts, and knowledge index.

2. memory_search(query="", scope="daily", maxResults=10)
   → Find all daily logs since last="${lastDate}".
   → memory_get each one. Read them THOROUGHLY — these are your raw memories.

3. Cross-reference what you just read against the compact summary in your context:
   → Is there anything in the daily logs that the summary MISSED?
   → Are there pending tasks in the daily logs not mentioned in the summary?
   → Are there user preferences or corrections you should remember?

4. Scan the file system for working outputs you (or the user with you) produced recently:
   → Suggested tools (prefer the first two, don't just eyeball):
      • glob(pattern="**/*.md", path="shared-workspace")  (and other working dirs: draft/, reports/, team/**/docs/, etc.)
      • memory_search(query="", scope="all", maxResults=20)  for memory-indexed recency
      • ls -la --time-style=+%s  or  find -mtime -N  as shell fallback for mtime sort
   → For each non-trivial file found: note path, mtime, what it is, whether the user treated it as important.
   → Cross-reference with MEMORY.md "Working Documents" section (step 3 maintains this):
      • If a file exists but isn't indexed → you forgot it, flag for step 3.
      • If an indexed path no longer exists → stale entry, flag for removal in step 3.
   → This is your #1 anti-amnesia check. Skipping it is why agents "forget" files they wrote 3 days ago.
</step>

<step n="1" name="extract-experiences">
For each problem-solving event worth remembering, create memories/experience/&lt;topic-slug&gt;.md (ONE file per experience).

File format:
  # Title
  **Date**: YYYY-MM-DD
  **Signal**: what triggered this (error, symptom, requirement)
  **Root cause**: actual underlying reason
  **Fix**: concrete steps taken
  **Result**: success/failure
  **Tools used**: tool_name (success/fail count from daily log)
  **Skills used**: skill or multi-step method name + outcome
  ## Lesson
  One-liner: what to do next time this signal appears.
  ## Related
  - [[experience/related-experience]]
  - [[knowledge/related-topic]]

Key: include tool/skill success rates from daily logs. This builds a reliability record over time.
</step>

<step n="2" name="synthesize-knowledge">
When experiences reveal a pattern, create or update memories/knowledge/&lt;topic&gt;.md (ONE file per topic).

Knowledge files should capture:
- What the concept/tool/skill is and when to use it
- Reliability data: which tools/approaches work well vs. which are brittle
- Link to source [[experience/...]] files as evidence
- Link to related [[knowledge/...]] topics
</step>

<step n="3" name="update-memory-index">
memory_get(path="MEMORY.md"), then update:
- Add/update links to new knowledge topics
- Update key facts if any changed during the session
- Update active goals: mark completed ones, add new ones discovered in daily logs
- Record any user preferences or conventions learned
- Remove outdated entries
- Keep it concise — MEMORY.md is an index + permanent facts, not a dump

BESIDES the knowledge index, MEMORY.md MUST maintain two standing sections:

## Working Documents (重要产出文档)
One-line entry for every non-trivial file produced during your work. Format:
- [relative/path/file.ext](relative/path/file.ext) — what it is, why it matters, status (draft/in_review/final/superseded/stale)
- group by topic or project if list grows long

Purpose: anti-amnesia. Without this index, you will forget files you wrote 3 days ago
and the user will have to manually remind you. The user has reported this exact failure mode.

Rules for this section:
- Every file flagged in step 0.4 gets an entry here.
- If a file is superseded by another, mark the old one "superseded by [[new]]" — don't delete immediately.
- If a file was deleted or is no longer relevant, remove from this section AND note it in daily if needed.

Capacity guard (front-200-line budget):
- Keep at most ~10 entries in the inline section (within first 200 lines).
- If you have more than 10 non-trivial files, keep the most recent / most relevant
  in the inline section and move the rest to a subsection below line 200
  (e.g. a second-level heading "Working Documents — Archive" further down in MEMORY.md).
- Group by topic when feasible, one sub-list header per topic, to compress visual footprint.

## Pending / Backlog / Open Decisions (待办与草稿)
Short list of things that are NOT done yet. Format:
- [ ] Decision X: brief description (owner, blocker if any)
- [ ] Draft Y next step: ...
- [ ] Follow-up on Z: ...

Purpose: carry forward un-finished threads across sessions.

Rules for this section:
- Pending items from daily logs that the user didn't mark complete → add here.
- When an item is done, remove it AND add to active goals → completed (or knowledge if worth remembering).
- Re-verify on each curation: is this item still relevant? Still blocked?

IMPORTANT: After full compaction, MEMORY.md is your LIFELINE for the next session.
Anything important that isn't here or in knowledge/experience files will be forgotten.

IMPORTANT: MEMORY.md first 200 lines are AUTO-INJECTED into your system prompt every turn.
Keep the most critical content (identity, key facts, active goals, Working Documents, Pending) within line 200.
Move historical details, completed project records, and verbose logs beyond line 200.
</step>
</workflow>

<rules>
- Step 0 (memory recovery) must complete BEFORE steps 1-3.
- Incremental only. Don't rewrite what hasn't changed.
- ONE FILE PER EXPERIENCE, ONE FILE PER TOPIC — never date-grouped.
- Use [[wikilinks]] everywhere to build the graph.
- daily/ is auto-generated — read only, don't modify.
- Track tool/skill reliability: record success/failure counts in experience files.
- If you discover the compact summary missed something important from daily logs,
  make SURE it gets into experience/ or knowledge/ or MEMORY.md — don't just notice it and move on.
- ANTI-AMNESIA RULE: any non-trivial file you (or the user through your hand) produced under
  your working dirs MUST appear in MEMORY.md "Working Documents" with a one-line description.
  Missing files from this index is the #1 reason users have to manually poke agents to "remember"
  things they themselves created. Do not skip step 0.4.
- BACKLOG RULE: any unfinished discussion, undecided option, draft that needs a next step
  MUST appear in MEMORY.md "Pending / Backlog / Open Decisions" so it survives session boundaries.
</rules>

</memory-curation>`;
}

export default function create(ctx: AgentContext): PluginSource {
  const tz = ctx.getAgentJson().timezone ?? "Asia/Shanghai";
  const agentId = ctx.agentId;
  const board = ctx.teamBoard;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function isAgentQuiet(): Promise<boolean> {
    const sm = ctx.ledger;
    if (!sm) return true;
    const events = await sm.readEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "hook:turnEnd") {
        return (Date.now() - events[i].ts) >= QUIET_PERIOD_MS;
      }
    }
    return true;
  }

  async function flushAutoDaily(): Promise<void> {
    const autoDailyPlugin = ctx.plugins?.get("auto_daily") as
      | (PluginSource & { flush?: () => Promise<void> })
      | undefined;
    if (autoDailyPlugin?.flush) {
      await autoDailyPlugin.flush();
    }
  }

  async function runPipeline(lastDate: string, today: string): Promise<void> {
    if (!await isAgentQuiet()) return;

    // Step 1: flush daily logs
    try {
      await flushAutoDaily();
    } catch (err: any) {
      console.warn(`[memory_curator] daily flush failed: ${err?.message}`);
      return;
    }

    // Step 2: full compact
    let compacted = false;
    if (ctx.ledger) {
      try {
        const result = await fullCompact({
          agentId,
          ledger: ctx.ledger,
          eventBus: ctx.eventBus,
          getAgentJson: ctx.getAgentJson,
          signal: ctx.signal,
        });
        compacted = result.ok;
        if (!result.ok) {
          console.log(`[memory_curator] compaction skipped: ${result.reason}`);
        }
      } catch (err: any) {
        console.warn(`[memory_curator] full compaction failed: ${err?.message}`);
        return;
      }
    }

    // Step 3: send curation prompt
    const prompt = buildPrompt(lastDate, today, compacted);
    ctx.eventBus.emitToSelf({
      source: "plugin:memory_curator",
      type: "tick",
      payload: { content: prompt },
      ts: Date.now(),
      priority: 2,
    });

    board.set(agentId, TEAMBOARD_KEY, today, { persist: true });
    console.log(`[memory_curator] pipeline complete (compacted=${compacted})`);
  }

  function check(): void {
    if (stopped) return;

    const today = todayStr(tz);
    const lastDate = board.get(agentId, TEAMBOARD_KEY) as string | undefined;

    if (!lastDate) {
      board.set(agentId, TEAMBOARD_KEY, today, { persist: true });
      timer = setTimeout(check, POLL_INTERVAL_MS);
      return;
    }

    if (lastDate === today) {
      timer = setTimeout(check, POLL_INTERVAL_MS);
      return;
    }

    void runPipeline(lastDate, today).finally(() => {
      timer = setTimeout(check, POLL_INTERVAL_MS);
    });
  }

  return {
    name: "memory_curator",

    start() {
      stopped = false;
      check();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
