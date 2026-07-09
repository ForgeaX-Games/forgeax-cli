/** Lazy persona sub-agent scaffold — SSOT for "the caller pinned a marketplace /
 *  plugin persona id (suzu / mochi / cc-coder / …) that the session tree doesn't
 *  have yet; materialize it on disk with the right personaFile / memoryDir /
 *  host-tools, then attach + start it so its EventBus queue is live before the
 *  caller routes anything to it".
 *
 *  Three call sites share this exact pipe (previously copy-pasted in all three):
 *   - POST /api/sessions/:sid/messages  — chat tab targets `to:'<persona>'`
 *   - delegate_to_subagent tool         — an agent hands work to a teammate
 *   - set_agent_models command          — picking a model on a persona you
 *                                         haven't messaged yet must create it,
 *                                         mirroring get_agent_model's existing
 *                                         pre-scaffold tolerance (else the model
 *                                         picker throws "agent path not found").
 *
 *  Idempotent: an id already in the tree returns `alreadyPresent` untouched.
 *  ensureAgentScaffold never clobbers an existing agent.json, so a later
 *  message-send scaffold preserves both the persona and any model written here.
 */
import type { Session } from "./session";
import { ensureAgentScaffold } from "./agent-scaffold";
import { resolvePersonaForAgent } from "../agents/loader";

export type PersonaScaffoldResult =
  | { ok: true; alreadyPresent: boolean }
  | { ok: false; code: "persona_not_found" | "scaffold_failed"; error: string };

/** Materialize `agentId` as a persona sub-agent of `session` if it isn't in the
 *  tree yet. Simple-name ids only — callers gate nested paths / fullIds out. */
export async function ensurePersonaScaffold(
  session: Session,
  agentId: string,
): Promise<PersonaScaffoldResult> {
  if (session.tree.get(agentId)) return { ok: true, alreadyPresent: true };

  const persona = await resolvePersonaForAgent(agentId);
  if (!persona) {
    return {
      ok: false,
      code: "persona_not_found",
      error:
        `persona '${agentId}' 未找到 —— 不在 marketplace 或 plugin 列表里。` +
        `请确认 plugin 已安装、id 拼写正确，或换一个已知 agent。`,
    };
  }

  try {
    await ensureAgentScaffold(session.sid, agentId, {
      agentType: "conscious",
      overrides: {
        personaFile: persona.personaPath,
        ...(persona.memoryDir ? { memoryDir: persona.memoryDir } : {}),
        ...(persona.tools && persona.tools.length > 0
          ? { kits: { config: { "host-tools": { allow: persona.tools } } } }
          : {}),
      },
    });
    // Attach + start synchronously so the tree node + EventBus queue exist right
    // away instead of racing the FSWatcher → tree → scheduler.attachAndStart
    // pipeline (debounced ~300ms).
    await session.scheduler.attachAgent(agentId);
    await session.scheduler.startAgent(agentId);
    return { ok: true, alreadyPresent: false };
  } catch (err: any) {
    return { ok: false, code: "scaffold_failed", error: err?.message ?? String(err) };
  }
}
