// @desc Unified reader for ~/.agenteam/key/tools.json with actionable missing-key diagnostics
import { readFile, writeFile } from "node:fs/promises";
import type { PathManagerAPI } from "../core/types.js";

const HOST_KEY_PATH = "~/.agenteam/key/tools.json";

export interface ToolKeysResult {
  /** All keys from tools.json (empty object if file missing or unparseable). */
  keys: Record<string, string>;
  /** True if the file was found and parsed successfully. */
  fileExists: boolean;
  /** Absolute path to the tools.json file. */
  filePath: string;
}

/**
 * Read and parse key/tools.json.
 * Returns the parsed keys and metadata — never throws.
 */
export async function readToolKeys(pathManager: PathManagerAPI): Promise<ToolKeysResult> {
  const filePath = pathManager.shared().toolsKey();
  try {
    const raw = await readFile(filePath, "utf-8");
    const keys = JSON.parse(raw) as Record<string, string>;
    return { keys, fileExists: true, filePath };
  } catch {
    return { keys: {}, fileExists: false, filePath };
  }
}

/**
 * Check if a specific key is present and non-empty.
 * Returns the value if found, or null if missing.
 */
export function getKey(result: ToolKeysResult, keyName: string): string | null {
  const val = result.keys[keyName];
  return val ? val : null;
}

/**
 * Generate a user-facing error message for a missing key.
 * Includes the host-side path so the user (or managing agent) knows exactly where to configure it.
 */
export function missingKeyMessage(keyName: string, purpose: string, fileExists: boolean): string {
  const lines = [
    `⚠️ \`${keyName}\` 未配置 — ${purpose}`,
    "",
    fileExists
      ? `请在宿主机 ${HOST_KEY_PATH} 中添加 "${keyName}" 字段。`
      : `宿主机 ${HOST_KEY_PATH} 文件不存在或不可读。请在宿主机上创建该文件并添加 "${keyName}" 字段。`,
    "",
    "示例：",
    "```json",
    `{`,
    `  "${keyName}": "<your-key-here>"`,
    `}`,
    "```",
    "",
    "注意：key/ 目录由宿主机管理，容器内无法直接修改。请在宿主机 ~/.agenteam/key/tools.json 中配置。",
  ];
  return lines.join("\n");
}

/**
 * Ensure empty placeholders exist in tools.json for all declared keys.
 * Called once at capability load time — collects requiredKeys from all tools
 * and writes any missing keys as empty strings so users know what to fill in.
 *
 * Only writes if there are new keys to add. Existing values are never overwritten.
 */
export async function ensureToolKeyPlaceholders(
  pathManager: PathManagerAPI,
  keys: Array<{ key: string; description: string }>,
): Promise<void> {
  if (keys.length === 0) return;

  const result = await readToolKeys(pathManager);
  if (!result.fileExists) return; // Don't create the file — ensureSharedConfigs handles that

  let dirty = false;
  for (const { key } of keys) {
    if (!(key in result.keys)) {
      result.keys[key] = "";
      dirty = true;
    }
  }

  if (dirty) {
    await writeFile(result.filePath, JSON.stringify(result.keys, null, 2) + "\n", "utf-8").catch(() => {});
  }
}
