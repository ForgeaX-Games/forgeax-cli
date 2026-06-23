// @desc AgentKindRegistry — pluggable map<kindId, AgentKind>.
//
// "AgentKind" = an agent's DEFINITION (class + persona + tools), NOT an
// instance. SessionRuntime.spawnRoot(kindId) / spawnSub(kindId) consult
// this registry to materialise a real BaseAgent instance inside the
// session.
//
// Source of registrations (P2.3+): marketplace plugins of kind="agent"
// register their definition on activate(). The legacy team manifest
// auto-spawn path is retired in P2.
//
// Phase status: Phase 0 — type-only stub.

import type { BaseAgent } from "../core/base-agent.js";
import type { AgentInitConfig } from "../core/types.js";

export interface AgentKindDefinition {
  /** kind id, e.g. "admin", "iori", "suzu". Unique per Instance. */
  readonly id: string;
  /** Display name surfaced in UI. */
  readonly displayName: string;
  /** Whether this kind is allowed as a session root (vs. sub-only). */
  readonly canBeRoot: boolean;
  /** Factory: build a fresh agent instance for a given session context. */
  spawn(init: AgentInitConfig): Promise<BaseAgent>;
}

export interface AgentKindRegistryAPI {
  register(def: AgentKindDefinition): void;
  unregister(kindId: string): void;
  get(kindId: string): AgentKindDefinition | null;
  list(): AgentKindDefinition[];
}

/** Placeholder until P2.3 wires marketplace plugins in. */
export class AgentKindRegistry implements AgentKindRegistryAPI {
  private readonly kinds = new Map<string, AgentKindDefinition>();

  register(def: AgentKindDefinition): void {
    this.kinds.set(def.id, def);
  }

  unregister(kindId: string): void {
    this.kinds.delete(kindId);
  }

  get(kindId: string): AgentKindDefinition | null {
    return this.kinds.get(kindId) ?? null;
  }

  list(): AgentKindDefinition[] {
    return [...this.kinds.values()];
  }
}
