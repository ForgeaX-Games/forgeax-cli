// @desc Key/Model route handlers — tool keys + model config CRUD.
// LLM-key endpoints retired 2026-05 along with llm_key.json; they now return
// HTTP 410 Gone with a hint pointing at .env. Routing is decided by id pattern
// in src/llm/auto-resolver.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { json, parseJsonBody, maskKey } from "./utils.js";

const LLM_KEY_RETIRED = {
  error: "llm_key.json retired — set credentials in $ROOT/.env instead",
  hint: "edit .env: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY / LITELLM_PROXY_KEY+LITELLM_PROXY_BASE_URL",
};

// ─── File helpers ───

function keyDir(stateDir: string): string {
  return join(stateDir, "key");
}

function readKeyFile(stateDir: string, filename: string): Record<string, unknown> {
  const filePath = join(keyDir(stateDir), filename);
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function writeKeyFile(stateDir: string, filename: string, data: Record<string, unknown>): void {
  const dir = keyDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2));
}

// ─── LLM Keys (RETIRED — 410 Gone) ───
// Endpoint stubs are kept so old gateway-ctl clients receive a clear hint
// instead of a silent 404. Drop entirely once no v0.x ctl is in the wild.

export function handleKeysLlmList(_stateDir: string, res: ServerResponse): void {
  json(res, 410, LLM_KEY_RETIRED);
}

export async function handleKeysLlmAdd(_stateDir: string, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, 410, LLM_KEY_RETIRED);
}

export async function handleKeysLlmUpdate(_stateDir: string, _req: IncomingMessage, res: ServerResponse, _section: string): Promise<void> {
  json(res, 410, LLM_KEY_RETIRED);
}

export function handleKeysLlmDelete(_stateDir: string, res: ServerResponse, _section: string): void {
  json(res, 410, LLM_KEY_RETIRED);
}

export function handleKeysLlmTest(_stateDir: string, res: ServerResponse, _section: string): void {
  json(res, 410, LLM_KEY_RETIRED);
}

// ─── Models ───

export function handleModelsList(stateDir: string, res: ServerResponse): void {
  json(res, 200, readKeyFile(stateDir, "models.json"));
}

export async function handleModelsUpdate(stateDir: string, req: IncomingMessage, res: ServerResponse, model: string): Promise<void> {
  const body = await parseJsonBody(req);
  const data = readKeyFile(stateDir, "models.json");
  data[model] = body;
  writeKeyFile(stateDir, "models.json", data);
  json(res, 200, { model, updated: true });
}

export function handleModelsDelete(stateDir: string, res: ServerResponse, model: string): void {
  const data = readKeyFile(stateDir, "models.json");
  if (!data[model]) { json(res, 404, { error: `Model "${model}" not found` }); return; }
  delete data[model];
  writeKeyFile(stateDir, "models.json", data);
  json(res, 200, { model, deleted: true });
}

// ─── Tool Keys ───

export function handleKeysToolsList(stateDir: string, res: ServerResponse): void {
  const data = readKeyFile(stateDir, "tools.json") as Record<string, string>;
  const masked: Record<string, string> = {};
  for (const [key, val] of Object.entries(data)) {
    masked[key] = val ? maskKey(val) : "";
  }
  json(res, 200, masked);
}

export async function handleKeysToolsAdd(stateDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ key?: string; value?: string }>(req);
  if (!body.key) { json(res, 400, { error: "Missing 'key'" }); return; }
  const data = readKeyFile(stateDir, "tools.json");
  data[body.key] = body.value ?? "";
  writeKeyFile(stateDir, "tools.json", data);
  json(res, 201, { key: body.key, created: true });
}

export async function handleKeysToolsUpdate(stateDir: string, req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
  const body = await parseJsonBody<{ value?: string }>(req);
  const data = readKeyFile(stateDir, "tools.json");
  data[key] = body.value ?? "";
  writeKeyFile(stateDir, "tools.json", data);
  json(res, 200, { key, updated: true });
}

export function handleKeysToolsDelete(stateDir: string, res: ServerResponse, key: string): void {
  const data = readKeyFile(stateDir, "tools.json");
  if (!(key in data)) { json(res, 404, { error: `Key "${key}" not found` }); return; }
  delete data[key];
  writeKeyFile(stateDir, "tools.json", data);
  json(res, 200, { key, deleted: true });
}
