/** @desc Container cleanup for team instances */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnAsync } from "./utils.js";

export async function removeContainers(instanceDir: string): Promise<{ removed: string[] }> {
  const registryPath = join(instanceDir, "containers.list");
  if (!existsSync(registryPath)) return { removed: [] };

  const text = readFileSync(registryPath, "utf-8").trim();
  const names = text ? text.split("\n").map(l => l.trim()).filter(Boolean) : [];
  if (names.length === 0) return { removed: [] };

  const removed: string[] = [];
  for (const name of names) {
    try {
      await spawnAsync("docker", ["rm", "-f", name]);
      removed.push(name);
    } catch {
      console.warn(`[TeamOps] Failed to remove container: ${name}`);
    }
  }

  await writeFile(registryPath, "", "utf-8");
  return { removed };
}
