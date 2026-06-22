/** @desc CLI — instance query commands via commands HTTP transport (tree / board / agent-json / sessions / session-events) */

import { type ConnInfo, apiCall, print, die, printTable, extractFlag } from "./http.js";

/** Helper: POST /commands/:name/query and unwrap the CommandResult envelope. */
async function cmdQuery(
  conn: ConnInfo,
  instId: string,
  name: string,
  args: string[] = [],
): Promise<unknown> {
  const { status, data } = await apiCall(
    conn, "POST",
    `/api/instances/${encodeURIComponent(instId)}/commands/${encodeURIComponent(name)}/query`,
    { args },
  );
  if (status >= 400 && status !== 500) die(JSON.stringify(data));
  const r = (data as { result?: { ok?: boolean; data?: unknown; error?: string } })?.result;
  if (!r?.ok) die(r?.error ?? `${name} failed`);
  return r.data;
}

export async function cmdInstanceTree(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  if (!instId) die("Usage: agenteam instance tree <id>");
  const nodes = (await cmdQuery(conn, instId, "fetch_agent_tree")) as Array<Record<string, unknown>>;
  if (!nodes || nodes.length === 0) {
    process.stdout.write("No agents in tree.\n");
    return;
  }
  printTable(
    ["AGENT_ID", "ROLE", "PARENT", "CHILDREN"],
    nodes.map((n) => [
      String(n.id ?? ""),
      String(n.role ?? ""),
      n.parentId ? String(n.parentId) : "(root)",
      Array.isArray(n.childIds) && n.childIds.length > 0 ? (n.childIds as string[]).join(", ") : "-",
    ]),
  );
}

export async function cmdInstanceBoard(conn: ConnInfo, args: string[]): Promise<void> {
  const agentId = extractFlag(args, "--agent");
  const instId = args[0];
  if (!instId) die("Usage: agenteam instance board <id> [--agent <agentId>]");
  print(await cmdQuery(conn, instId, "fetch_teamboard", agentId ? [agentId] : []));
}

export async function cmdInstanceAgentJson(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const agentId = args[1];
  if (!instId || !agentId) die("Usage: agenteam instance agent-json <id> <agentId>");
  print(await cmdQuery(conn, instId, "fetch_agent_json", [agentId]));
}

export async function cmdInstanceSessions(conn: ConnInfo, args: string[]): Promise<void> {
  const agentId = extractFlag(args, "--agent");
  const instId = args[0];
  if (!instId || !agentId) die("Usage: agenteam instance sessions <id> --agent <agentId>");
  print(await cmdQuery(conn, instId, "list_sessions", [agentId]));
}

/** Session events (tail raw JSONL since last compact) via commands HTTP. */
export async function cmdInstanceSessionEvents(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  const agentId = args[1];
  if (!instId || !agentId) die("Usage: agenteam instance session-events <id> <agentId>");
  print(await cmdQuery(conn, instId, "fetch_session_events", [agentId]));
}
