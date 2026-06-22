/** @desc Gateway type definitions — context and route */

import type { InstanceHandle } from "../core/types.js";
import type { PackRegistry } from "./packs/pack-registry.js";
import type { PortMapping } from "./port-allocator.js";

export type { GatewayRoute } from "./config.js";

export interface GatewayContext {
  readonly stateDir: string;
  getInstance(id: string): InstanceHandle | undefined;
  getDefaultInstance(): InstanceHandle;
  listInstances(): { id: string; status: import("../core/types.js").InstanceStatus; statusMessage?: string; provisioningPhase?: import("../core/types.js").ProvisioningPhase; autoStart: boolean; createdAt: string }[];
  packRegistry: PackRegistry;

  resolveRoute(externalId: string): { instance: InstanceHandle; agentId?: string } | null;
  addInstance(id: string): Promise<InstanceHandle>;
  startInstance(id: string): Promise<void>;
  stopInstance(id: string): Promise<void>;
  shutdownInstance(id: string): Promise<void>;
  restartInstance(id: string): Promise<void>;
  freeInstance(id: string): Promise<void>;
  syncInstance(id: string): Promise<{ status: "ok" | "conflict"; message: string }>;
  getPortMappings(id: string): PortMapping[];
  shutdownGateway(): Promise<void>;

  teamLoad(id: string, packId: string, opts?: { forkId?: string }): Promise<void>;
  teamSave(id: string, name: string): Promise<void>;
  teamRestore(id: string, backupName: string): Promise<void>;
  teamUpdateManifest(id: string, patch: Record<string, unknown>): Promise<void>;
  teamUpdate(id: string): Promise<import("./team/types.js").UpdateTeamResult>;
  teamDeleteBackup(id: string, backupName: string): Promise<void>;
  teamRemoveContainers(id: string): Promise<{ removed: string[] }>;
  teamSyncPreview(id: string): Promise<import("./team/types.js").SyncPreview>;
  teamSyncExecute(id: string, newVersion: string): Promise<void>;

  packCleanImage(packId: string): Promise<{ imageRemoved: boolean; tarRemoved: boolean; cacheCleared: boolean }>;
}
