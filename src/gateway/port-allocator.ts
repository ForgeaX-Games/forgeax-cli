/**
 * @desc PortAllocator — Gateway 级端口分配器。
 *
 * 跨 Instance 全局协调宿主机端口分配，避免多 Instance 同 pack 端口冲突。
 * 策略：优先 hostPort === containerPort（用户友好），冲突时递增寻找空闲端口。
 * Sticky：同 instance 同 containerPorts 复用已有分配，避免 worker restart 时端口漂移。
 */

import { createServer } from "node:net";
import type { PortMapping } from "../sandbox/manager.js";

export type { PortMapping };

export interface PortAllocatorConfig {
  reserved?: number[];
  dynamicRange?: [number, number];
}

const DEFAULT_RANGE: [number, number] = [10000, 60000];

export class PortAllocator {
  private allocations = new Map<string, PortMapping[]>();
  private occupied = new Set<number>();
  private readonly reserved: Set<number>;
  private readonly range: [number, number];

  constructor(config?: PortAllocatorConfig) {
    this.reserved = new Set(config?.reserved ?? []);
    this.range = config?.dynamicRange ?? DEFAULT_RANGE;
  }

  async allocate(instanceId: string, containerPorts: number[]): Promise<PortMapping[]> {
    const uniquePorts = [...new Set(containerPorts)];

    // Empty request → release and return
    if (uniquePorts.length === 0) {
      this._releaseInternal(instanceId);
      return [];
    }

    // Sticky: if same instance requests the same container ports, reuse existing allocation
    const existing = this.allocations.get(instanceId);
    if (existing) {
      const existingCPs = existing.map(m => m.containerPort).sort((a, b) => a - b).join(",");
      const requestedCPs = [...uniquePorts].sort((a, b) => a - b).join(",");
      if (existingCPs === requestedCPs) return existing;
      // Container ports changed — release old allocation before re-allocating
      this._releaseInternal(instanceId);
    }

    const mappings: PortMapping[] = [];
    for (const cp of uniquePorts) {
      const hp = await this._findAvailablePort(cp);
      const mapping: PortMapping = { containerPort: cp, hostPort: hp, protocol: "tcp" };
      mappings.push(mapping);
      this.occupied.add(hp);
    }

    this.allocations.set(instanceId, mappings);
    return mappings;
  }

  release(instanceId: string): void {
    this._releaseInternal(instanceId);
  }

  getMappings(instanceId: string): PortMapping[] {
    return this.allocations.get(instanceId) ?? [];
  }

  private _releaseInternal(instanceId: string): void {
    const mappings = this.allocations.get(instanceId);
    if (!mappings) return;
    for (const m of mappings) this.occupied.delete(m.hostPort);
    this.allocations.delete(instanceId);
  }

  private async _findAvailablePort(preferred: number): Promise<number> {
    if (!this.occupied.has(preferred) && !this.reserved.has(preferred)) {
      if (await isPortFree(preferred)) return preferred;
    }

    const adjacentMax = Math.min(preferred + 100, 65535);
    for (let port = preferred + 1; port <= adjacentMax; port++) {
      if (this.occupied.has(port) || this.reserved.has(port)) continue;
      if (await isPortFree(port)) return port;
    }

    const [lo, hi] = this.range;
    for (let port = lo; port <= hi; port++) {
      if (this.occupied.has(port) || this.reserved.has(port)) continue;
      if (await isPortFree(port)) return port;
    }

    throw new Error(`PortAllocator: no free port found in range [${lo}, ${hi}]`);
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}
