import { isAbsolute, resolve } from "node:path";
import type { AgentJson, PathManagerAPI } from "../core/types.js";

export const TEAMBOARD_KEYS = {
  AGENT_ID: "AGENT_ID",
  AGENT_DIR: "AGENT_DIR",
  HOME_DIR: "HOME_DIR",
  SHARED_WORKSPACE: "SHARED_WORKSPACE",
  CURRENT_DIR: "CURRENT_DIR",
  CURRENT_TIME: "CURRENT_TIME",
  ACTIVE_TOOLS: "ACTIVE_TOOLS",
  RUNNING: "RUNNING",
  STATUS: "STATUS",
  LAST_USER_INPUT_AT: "LAST_USER_INPUT_AT",
} as const;

/** Describes built-in teamboard variables and their persistence policy. */
export const BUILTIN_TEAMBOARD_VARS = [
  { key: TEAMBOARD_KEYS.AGENT_ID, persisted: false, description: "Current agent id." },
  { key: TEAMBOARD_KEYS.AGENT_DIR, persisted: false, description: "Current agent config directory." },
  { key: TEAMBOARD_KEYS.HOME_DIR, persisted: false, description: "Current agent private home directory (homes/{id}/)." },
  { key: TEAMBOARD_KEYS.SHARED_WORKSPACE, persisted: false, description: "Team shared workspace directory." },
  { key: TEAMBOARD_KEYS.CURRENT_DIR, persisted: false, description: "Current working directory, auto-synced with the foreground shell cwd; initialized from agent.json.defaultDir or HOME_DIR." },
  { key: TEAMBOARD_KEYS.CURRENT_TIME, persisted: false, description: "Wall-clock time refreshed before each prompt assembly." },
  { key: TEAMBOARD_KEYS.ACTIVE_TOOLS, persisted: false, description: "Active tool metadata rendered by the tools slot." },
  { key: TEAMBOARD_KEYS.RUNNING, persisted: false, description: "Whether the agent is currently inside an agentic loop turn." },
  { key: TEAMBOARD_KEYS.STATUS, persisted: true, description: "Agent operational status (e.g. 'plan_mode'). Defaults to agentJson.defaultStatus or empty string. Persisted so plan_mode survives restarts." },
  { key: TEAMBOARD_KEYS.LAST_USER_INPUT_AT, persisted: true, description: "Wall-clock ts (ms) of the last real user input event (type=='user_input'). Used by microCompact as the per-agent idle-gap anchor. Persisted so idle judgement survives restarts." },
] as const;

export function resolveAgentDefaultDir(
  agentId: string,
  agentJson: AgentJson,
  pathManager: PathManagerAPI,
): string {
  const homeDir = pathManager.team().homeFor(agentId);
  const rawDefault = agentJson.defaultDir;
  if (!rawDefault) return homeDir;
  return isAbsolute(rawDefault) ? rawDefault : resolve(homeDir, rawDefault);
}

/** Persist policy lookup for built-in keys. */
const PERSIST_POLICY = new Map<string, boolean>(
  BUILTIN_TEAMBOARD_VARS.map((v) => [v.key, v.persisted]),
);

export interface BuiltinVar {
  value: unknown;
  persist: boolean;
}

export function buildBuiltinTeamBoardVars(
  agentId: string,
  agentDir: string,
  pathManager: PathManagerAPI,
  agentJson?: AgentJson,
): Record<string, BuiltinVar> {
  const homeDir = pathManager.team().homeFor(agentId);
  const sharedWorkspace = pathManager.team().sharedWorkspace();
  const defaultDir = resolveAgentDefaultDir(agentId, agentJson ?? {} as AgentJson, pathManager);

  const entries: Record<string, unknown> = {
    [TEAMBOARD_KEYS.AGENT_ID]: agentId,
    [TEAMBOARD_KEYS.AGENT_DIR]: agentDir,
    [TEAMBOARD_KEYS.HOME_DIR]: homeDir,
    [TEAMBOARD_KEYS.SHARED_WORKSPACE]: sharedWorkspace,
    [TEAMBOARD_KEYS.CURRENT_DIR]: defaultDir,
    [TEAMBOARD_KEYS.RUNNING]: false,
    [TEAMBOARD_KEYS.STATUS]: agentJson?.defaultStatus ?? "",
  };

  const result: Record<string, BuiltinVar> = {};
  for (const [key, value] of Object.entries(entries)) {
    result[key] = { value, persist: PERSIST_POLICY.get(key) ?? false };
  }
  return result;
}
