/** game_charter slot — injects the forgeax game-authoring contract into every
 *  native-agent turn (root/Forge + delegated coders).
 *
 *  Why this exists: the contract used to live ONLY inside the claude-code CLI
 *  provider's `--append-system-prompt`, so the native orchestration path never
 *  saw it. Result: root would tell a coder to "generate the game under
 *  /some/path/<name>" (a folder OUTSIDE `.forgeax/games/`) and coders would
 *  hand-write standalone HTML instead of forgeax-engine ECS code. This slot
 *  closes that gap by reusing the same SSOT (`src/agents/game-charter`) the CLI
 *  provider consumes, so the two paths can never drift.
 *
 *  Priority STATIC_FRAMEWORK (10) + cacheHint "stable" so it sits high in the
 *  cache-friendly prefix, just under STATIC_CORE, ahead of the environment slot
 *  (40). Active-game scoping is appended so "the game" follows the user's
 *  current game without re-deriving it per tool.
 */

import type { ContextSlot } from "../../../../src/kits/slot/types";
import { SlotPriority } from "../../../../src/kits/slot/types";
import type { AgentContext } from "../../../../src/core/types";
import { defaultProjectRoot } from "../../../../src/api/lib/safe-path";
import { getActiveGame } from "../../../../src/api/lib/active-game";
import { buildGameCharter, buildActiveGameNote } from "../../../../src/agents/game-charter";

function render(): string {
  const serverPort = process.env.FORGEAX_SERVER_PORT ?? "18900";
  const interfacePort = process.env.FORGEAX_INTERFACE_PORT ?? "18920";
  const charter = buildGameCharter({ serverPort, interfacePort });
  const note = buildActiveGameNote(getActiveGame(defaultProjectRoot()));
  return note ? `${charter}\n\n${note}` : charter;
}

export default function gameCharterSlot(_ctx: AgentContext): ContextSlot {
  return {
    name: "game_charter",
    description:
      "Authoritative contract for authoring forgeax-engine games: games live " +
      "only at .forgeax/games/<slug>/, scaffold (don't invent folders), ECS " +
      "TypeScript (never standalone HTML), active-game scoping. Mirrors the " +
      "claude-code CLI's appended system prompt so native-agent turns get the " +
      "same rules.",
    priority: SlotPriority.STATIC_FRAMEWORK,
    cacheHint: "stable",
    version: 1,
    content: () => render(),
  };
}
