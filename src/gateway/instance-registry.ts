/**
 * @desc Instance Registry — 发现 Instance 以目录为准，meta 为辅助信息。
 *
 * 判定规则：~/.agenteam/instances/{id}/ 目录存在 = Instance 存在。
 * meta（~/.agenteam/instance-meta/{id}.json）只存 autoStart / createdAt，
 * 没有 meta 的 Instance 视为 autoStart: true。
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface InstanceMeta {
  createdAt: string;
  autoStart: boolean;
}

const DEFAULT_META: InstanceMeta = { createdAt: "", autoStart: true };

function metaDir(stateDir: string): string {
  return join(stateDir, "instance-meta");
}

function metaPath(stateDir: string, instanceId: string): string {
  return join(metaDir(stateDir), `${instanceId}.json`);
}

export function readInstanceMeta(stateDir: string, instanceId: string): InstanceMeta {
  const p = metaPath(stateDir, instanceId);
  if (!existsSync(p)) return { ...DEFAULT_META };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return {
      createdAt: raw.createdAt ?? "",
      autoStart: raw.autoStart !== false,
    };
  } catch { return { ...DEFAULT_META }; }
}

export function writeInstanceMeta(stateDir: string, instanceId: string, meta: InstanceMeta): void {
  const dir = metaDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(stateDir, instanceId), JSON.stringify(meta, null, 2) + "\n");
}

export function removeInstanceMeta(stateDir: string, instanceId: string): void {
  try { unlinkSync(metaPath(stateDir, instanceId)); } catch {}
}

/**
 * 发现所有 Instance — 以 instances/ 目录为准。
 * 目录存在 = Instance 存在。没有 meta 的自动补建。
 */
export function discoverInstances(stateDir: string): { id: string; meta: InstanceMeta }[] {
  const dir = join(stateDir, "instances");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      let meta = readInstanceMeta(stateDir, e.name);
      if (!meta.createdAt) {
        meta = { createdAt: new Date().toISOString(), autoStart: true };
        writeInstanceMeta(stateDir, e.name, meta);
      }
      return { id: e.name, meta };
    });
}
