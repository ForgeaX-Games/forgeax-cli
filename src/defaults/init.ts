/** 配置文件初始化 — 确保必要的配置文件存在，并对 catalog 类文件做增量合并 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_AGENTEAM_JSON,
  DEFAULT_MODELS_JSON,
} from "./gateway/index.js";

/**
 * 如果文件不存在则创建
 * @returns true 如果创建了文件
 */
async function ensureFile(path: string, content: unknown): Promise<boolean> {
  if (existsSync(path)) return false;
  await writeFile(path, JSON.stringify(content, null, 2) + "\n", "utf-8");
  return true;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Ensure a catalog-style JSON file (flat dict of entries) exists, and
 * incrementally merge new top-level entries from `defaults` into the
 * existing file. Existing entries are never overwritten.
 *
 * @param mergeExtra  Optional hook to perform additional merges (e.g. nested
 *                    array merges) on the user file. Receives the current
 *                    user config after top-level merge. Return `true` if
 *                    additional changes were made that require a write.
 * @returns           Summary of what happened.
 */
async function ensureCatalogFile<T extends Record<string, unknown>>(
  path: string,
  defaults: T,
  mergeExtra?: (
    current: Record<string, unknown>,
    addedKeys: string[],
  ) => { changed: boolean; extraInfo: string[] },
): Promise<
  | { action: "created" }
  | { action: "merged"; addedKeys: string[]; extraInfo: string[] }
  | { action: "unchanged" }
  | { action: "skipped"; reason: string }
> {
  if (!existsSync(path)) {
    await writeFile(path, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
    return { action: "created" };
  }

  // Read existing
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    return {
      action: "skipped",
      reason: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return { action: "skipped", reason: "not a JSON object at top level" };
  }

  // Top-level merge: add missing keys only
  const addedKeys: string[] = [];
  for (const key of Object.keys(defaults)) {
    if (!(key in existing)) {
      existing[key] = defaults[key];
      addedKeys.push(key);
    }
  }

  // Optional additional merge step
  const extra = mergeExtra?.(existing, addedKeys) ?? { changed: false, extraInfo: [] };
  const changed = addedKeys.length > 0 || extra.changed;
  if (!changed) return { action: "unchanged" };

  await writeFile(path, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  return { action: "merged", addedKeys, extraInfo: extra.extraInfo };
}

/**
 * 确保 SharedLayer（~/.agenteam）级共享配置存在
 * - key/models.json (catalog of model specs; credentials live in $ROOT/.env)
 * - packs/
 *
 * llm_key.json was retired 2026-05 — credentials come from .env, routing is
 * decided by id pattern in src/llm/auto-resolver.ts.
 */
export async function ensureSharedConfigs(stateDir: string): Promise<void> {
  await ensureDir(join(stateDir, "key"));
  await ensureDir(join(stateDir, "packs"));
  await ensureDir(join(stateDir, "cache"));

  const modelsPath = join(stateDir, "key", "models.json");
  const modelsResult = await ensureCatalogFile(modelsPath, DEFAULT_MODELS_JSON);
  switch (modelsResult.action) {
    case "created":
      console.log("Created default key/models.json");
      break;
    case "merged":
      if (modelsResult.addedKeys.length > 0) {
        console.log(`Updated key/models.json — added models: ${modelsResult.addedKeys.join(", ")}`);
      }
      break;
    case "skipped":
      console.warn(`Skipped key/models.json merge: ${modelsResult.reason}`);
      break;
  }

  const gwPath = join(stateDir, "gateway.json");
  if (await ensureFile(gwPath, { token: `at_${randomBytes(24).toString("hex")}`, host: "127.0.0.1", port: 3700 })) {
    console.log("Created gateway.json with auto-generated token");
  }

  const atPath = join(stateDir, "agenteam.json");
  if (await ensureFile(atPath, DEFAULT_AGENTEAM_JSON)) {
    console.log("Created default agenteam.json");
  }
}
