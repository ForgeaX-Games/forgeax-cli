/** @desc CLI — instance lifecycle commands */

import { type ConnInfo, apiCall, print, die } from "./http.js";

export async function cmdInstances(conn: ConnInfo): Promise<void> {
  const { data } = await apiCall(conn, "GET", "/api/instances");
  print(data);
}

export async function cmdInstanceAdd(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance add <id>");
  const { status, data } = await apiCall(conn, "POST", "/api/instances", { id });
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceDetail(conn: ConnInfo, args: string[]): Promise<void> {
  const instId = args[0];
  if (!instId) die("Usage: agenteam instance detail <id>");
  const { status, data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(instId)}`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceStart(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance start <id>");
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/start`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceStop(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance stop <id>");
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/stop`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceRestart(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance restart <id>");
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/restart`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceShutdown(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance shutdown <id>");
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/shutdown`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceFree(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance free <id>");
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/free`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceSync(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance sync <id>");
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/sync`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstanceInterrupt(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance interrupt <id>");
  const { status, data } = await apiCall(conn, "POST", `/api/instances/${encodeURIComponent(id)}/interrupt`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdInstancePorts(conn: ConnInfo, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("Usage: agenteam instance ports <id>");
  const { status, data } = await apiCall(conn, "GET", `/api/instances/${encodeURIComponent(id)}/ports`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}
