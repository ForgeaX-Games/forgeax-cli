/** @desc CLI — key (LLM, tool) & model commands */

import { type ConnInfo, apiCall, print, die, extractFlag } from "./http.js";

// ─── LLM Keys ───

export async function cmdKeysLlmList(conn: ConnInfo): Promise<void> {
  const { data } = await apiCall(conn, "GET", "/api/keys/llm");
  print(data);
}

export async function cmdKeysLlmAdd(conn: ConnInfo, args: string[]): Promise<void> {
  const section = extractFlag(args, "--section");
  const apiKey = extractFlag(args, "--key");
  const api = extractFlag(args, "--api");
  const apiBase = extractFlag(args, "--base");
  if (!section || !apiKey || !api) die("Usage: agenteam key llm add --section <name> --key <api_key> --api <adapter> [--base <url>]");
  const body: Record<string, unknown> = { section, api_key: apiKey, api };
  if (apiBase) body.api_base = apiBase;
  const { status, data } = await apiCall(conn, "POST", "/api/keys/llm", body);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdKeysLlmUpdate(conn: ConnInfo, args: string[]): Promise<void> {
  const section = args[0];
  if (!section) die("Usage: agenteam key llm update <section> [--key <api_key>] [--api <adapter>] [--base <url>]");
  const apiKey = extractFlag(args, "--key");
  const api = extractFlag(args, "--api");
  const apiBase = extractFlag(args, "--base");
  const body: Record<string, unknown> = {};
  if (apiKey) body.api_key = apiKey;
  if (api) body.api = api;
  if (apiBase !== undefined) body.api_base = apiBase;
  const { status, data } = await apiCall(conn, "PUT", `/api/keys/llm/${encodeURIComponent(section)}`, body);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdKeysLlmDelete(conn: ConnInfo, args: string[]): Promise<void> {
  const section = args[0];
  if (!section) die("Usage: agenteam key llm delete <section>");
  const { status, data } = await apiCall(conn, "DELETE", `/api/keys/llm/${encodeURIComponent(section)}`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdKeysLlmTest(conn: ConnInfo, args: string[]): Promise<void> {
  const section = args[0];
  if (!section) die("Usage: agenteam key llm test <section>");
  const { status, data } = await apiCall(conn, "POST", `/api/keys/llm/${encodeURIComponent(section)}/test`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

// ─── Tool Keys ───

export async function cmdKeysToolsList(conn: ConnInfo): Promise<void> {
  const { data } = await apiCall(conn, "GET", "/api/keys/tools");
  print(data);
}

export async function cmdKeysToolsAdd(conn: ConnInfo, args: string[]): Promise<void> {
  const key = args[0];
  const value = args[1] ?? "";
  if (!key) die("Usage: agenteam key tool add <key> [value]");
  const { status, data } = await apiCall(conn, "POST", "/api/keys/tools", { key, value });
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdKeysToolsUpdate(conn: ConnInfo, args: string[]): Promise<void> {
  const key = args[0];
  const value = args[1];
  if (!key || value === undefined) die("Usage: agenteam key tool update <key> <value>");
  const { status, data } = await apiCall(conn, "PUT", `/api/keys/tools/${encodeURIComponent(key)}`, { value });
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdKeysToolsDelete(conn: ConnInfo, args: string[]): Promise<void> {
  const key = args[0];
  if (!key) die("Usage: agenteam key tool delete <key>");
  const { status, data } = await apiCall(conn, "DELETE", `/api/keys/tools/${encodeURIComponent(key)}`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

// ─── Models ───

export async function cmdModelsList(conn: ConnInfo): Promise<void> {
  const { data } = await apiCall(conn, "GET", "/api/models");
  print(data);
}

export async function cmdModelsUpdate(conn: ConnInfo, args: string[]): Promise<void> {
  const model = args[0];
  const jsonStr = args[1];
  if (!model || !jsonStr) die("Usage: agenteam model update <model> '<json>'");
  let body: Record<string, unknown>;
  try { body = JSON.parse(jsonStr); } catch { die("Invalid JSON: " + jsonStr); }
  const { status, data } = await apiCall(conn, "PUT", `/api/models/${encodeURIComponent(model)}`, body!);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}

export async function cmdModelsDelete(conn: ConnInfo, args: string[]): Promise<void> {
  const model = args[0];
  if (!model) die("Usage: agenteam model delete <model>");
  const { status, data } = await apiCall(conn, "DELETE", `/api/models/${encodeURIComponent(model)}`);
  if (status >= 400) die(JSON.stringify(data));
  print(data);
}
