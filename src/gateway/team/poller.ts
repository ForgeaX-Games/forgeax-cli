/** @desc TeamUpdatePoller — periodic version check and auto-update for running teams */

import type { Gateway } from "../gateway.js";

export class TeamUpdatePoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gateway: Gateway,
    private readonly intervalMs = 10_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.poll(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.gateway.reapDeletedInstances();

      const instances = this.gateway.listRunningInstances();
      for (const id of instances) {
        try {
          const result = await this.gateway.teamUpdate(id);
          if (result.status === "updated") {
            console.log(`[TeamUpdatePoller] ${id}: ${result.message}`);
          }
        } catch (err: any) {
          if (err?.message?.includes("already in progress")) continue;
          console.warn(`[TeamUpdatePoller] Failed to check '${id}':`, err);
        }
      }
    } catch (err) {
      console.warn("[TeamUpdatePoller] Poll cycle failed:", err);
    }
  }
}
