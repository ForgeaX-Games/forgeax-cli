# ForgeaX Studio — forgeax-cli

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **The multi-agent orchestration kernel — an explicit AgentTree, an XML execution ledger, and a slot-composed, cache-friendly prompt. This is the runtime that drives Forge and her sub-agents.**

`forgeax-cli` is the agent runtime kernel for ForgeaX. Hosted **in-process by**
`@forgeax/server`, it turns a single chat request into a coordinated team of agents that plan,
delegate, write engine code, and report back. Where most "agent frameworks" are a thin loop over
one model call, this is a real orchestration runtime: a typed agent tree, a replayable message
ledger, sandboxed execution, and a prompt assembled from prioritized fragments.

## Bring your own agent — use the subscription you already have

ForgeaX is **not locked to one model vendor**. The kernel drives Forge through a pluggable
**driver** layer (the `cli-*` providers), so you can run the whole studio on the coding-agent
**subscription you already pay for** — or on a plain API key:

- **[Claude Code](https://claude.com/product/claude-code)** — run on your **Claude Pro / Max**
  plan, or an **Anthropic API key**.
- **[OpenAI Codex](https://developers.openai.com/codex)** — sign in with your
  **ChatGPT Plus / Pro** plan, or an **OpenAI API key**.
- **[Cursor](https://cursor.com/cli)** — connect your **Cursor Pro** subscription via the
  Cursor Agent CLI.

The persona is independent of the driver: the same **Forge** runs on whichever agent you choose,
and you can switch providers without rewriting anything. No second AI bill, no vendor lock-in.

## Why it's different

- **The agent team is an explicit data structure, not an emergent prompt trick.** Relationships
  live in an in-memory **AgentTree** with three clear roles — **router** (routes requests,
  doesn't do the work), **admin** (coordinates the team, plans, allocates), and **worker**
  (executes concrete tasks). The tree is deliberately *not* mirrored onto the filesystem (no deep
  nested path hell); it lives in memory plus a `team-state.xml` snapshot.
- **XML is a first-class system primitive, used for compaction — not just transport.**
  Agent-to-agent turns are XML (`<turn>` / `<agent_message>`), and a `ledger.xml` records the full
  execution history with **replay**. Crucially, when context gets long the kernel **folds** old
  content under `<compact>` instead of discarding it — you lose tokens, not memory.
- **Prompt-cache-friendly by construction.** The XML layout keeps invariants (system + prior
  turns) at the front and appends each new turn at the tail, so Anthropic prompt-cache hit rates
  stay high across a long session — directly cheaper and faster, by design rather than by luck.
- **The system prompt is composed, not hardcoded.** It is assembled at runtime from
  priority-ordered **Slot** fragments:
  `soul(0) → framework-cognition(10) → core-principle(20) → memory(30) → environment(40) →
  skills(110) → tools(130) → context/todos(150) → subagents(200)`. Personas, skills, and tools
  slot in by priority instead of being baked into one string.
- **Real-time steering.** A **Gateway** of LLM-free ScriptAgents handles external ingress
  (WebSocket / HTTP), using EventBus `steer` signals to interrupt and redirect a running agent
  mid-turn.

## Architecture (src/)

| Area | Role |
|:--|:--|
| `tree` / `team` | the explicit AgentTree + team coordination and `team-state.xml` |
| `gateway` | LLM-free ScriptAgent ingress (WS/HTTP) + steer signals |
| `message` / `context-window` | XML turn envelopes, the replayable ledger, compaction/fold |
| `capability` (`command` / `plugin` / `slot` / `tool`) | the extensible capability model |
| `llm` | provider/driver layer for model calls |
| `sandbox` | container-based isolation (setup/recovery, fs-bridge, port-forwarder) |
| `session` / `registries` / `memory` / `hooks` | session lifecycle, registries, persistent memory, lifecycle hooks |
| `core` | the kernel loop tying it together |

## Key concepts

`AgentTree` (router / admin / worker) · `team-state.xml` (tree snapshot) · `<turn>` /
`ledger.xml` (XML envelope + replayable history) · `<compact>` (fold-don't-discard compaction) ·
**Slot** (priority-ordered prompt fragments) · **Gateway / ScriptAgent** (LLM-free ingress) ·
`steer` (real-time interruption) · capability = `command` / `plugin` / `slot` / `tool`.

## How it fits the studio

When you chat with **Forge** in Studio, the server hands the turn to this kernel. Forge (an
admin) plans the work, spawns sub-agents (workers) to research, design, and write engine code,
and the results flow back through the XML ledger to the UI — while you can steer at any moment.
Because the kernel runs in-process inside the server, there is no separate daemon to manage.

## Orientation

The kernel is started by the studio's server, not run by hand in normal use. For standalone
development the package exposes a `forgeax` binary (`bin/forgeax`) and `start` / `dev` scripts;
each `src/<area>/README.md` documents that subsystem's contracts.

---

Part of the **ForgeaX Studio** monorepo. This repo is a submodule of
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) — clone that
with `--recurse-submodules` to run the full studio. License: Apache-2.0.
