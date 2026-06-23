/** @desc Shared helpers for team operations */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { PackJson } from "../../defaults/pack/pack-json.js";

export function readPackJson(packDir: string): PackJson {
  const filePath = join(packDir, "pack.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`pack.json not found at ${filePath}`);
  }
  try {
    return JSON.parse(raw) as PackJson;
  } catch {
    throw new Error(`pack.json is not valid JSON at ${filePath}`);
  }
}

/** Bump a semver string by major/minor/patch. */
export function bumpVersion(current: string, type: "major" | "minor" | "patch"): string {
  const parts = current.split(".").map(Number);
  while (parts.length < 3) parts.push(0);
  switch (type) {
    case "major": return `${parts[0] + 1}.0.0`;
    case "minor": return `${parts[0]}.${parts[1] + 1}.0`;
    case "patch": return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

export function spawnAsync(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], cwd: opts.cwd });
    child.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`${cmd} ${args[0]} failed (exit code ${code})`)); });
    child.on("error", reject);
  });
}
