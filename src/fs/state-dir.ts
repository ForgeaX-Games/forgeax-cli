/** @desc Resolve shared state directory (~/.agenteam) and provide Gateway-level path helpers */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SharedLayerAPI } from "../core/types.js";

export function resolveStateDir(env = process.env): string {
  const override = env.AGENTEAM_STATE_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".agenteam");
}

class SharedPaths implements SharedLayerAPI {
  constructor(private readonly r: string) {}

  root() { return this.r; }
  keyDir() { return join(this.r, "key"); }
  toolsKey() { return join(this.r, "key", "tools.json"); }
  packsDir() { return join(this.r, "packs"); }
  gatewayConfig() { return join(this.r, "gateway.json"); }
  gatewayLog() { return join(this.r, "gateway.log"); }
  instancesDir() { return join(this.r, "instances"); }
  instanceDir(instanceId: string) { return join(this.r, "instances", instanceId); }
  agenteamConfig() { return join(this.r, "agenteam.json"); }
  cacheDir() { return join(this.r, "cache"); }
  adapterCache(adapterName: string) { return join(this.r, "cache", adapterName); }
}

let _shared: SharedPaths | null = null;

/**
 * Gateway-level shared paths rooted at stateDir (~/.agenteam).
 * Independent of PathManager — no instance context needed.
 */
export function getSharedPaths(stateDir?: string): SharedLayerAPI {
  if (!_shared) {
    _shared = new SharedPaths(stateDir ?? resolveStateDir());
  }
  return _shared;
}
