/**
 * Phase D4 (extension) — event-trigger runtime for skills.
 *
 * Spec: 04-SKILL-FORMAT-V2 §triggers. The schema accepts
 * `{ kind: 'event', topic: '<bus glob>' }`, but the runner never subscribed
 * — the audit doc flags this as "ui/event 只走 schema". This module closes
 * the loop:
 *
 *   syncEventTriggerBindings(snapshot) reads every skill's triggers[],
 *   subscribes one bus listener per `{kind:'event'}` entry, and on fire
 *   invokes runSkill with input={event}. It is idempotent: a second call
 *   tears down the previous bindings and rebuilds from the new snapshot,
 *   so reloadPlugins() can wire it after each rebuild.
 *
 * Loop guard: a synthetic `caller.kind = 'event'` is set so emitted
 * skill.* events carry that origin. Skills that re-emit events that
 * match their own topic still loop — authors must avoid that. We do not
 * try to dedupe across the bridge.
 *
 * Bindings track the snapshot generation; tests (and the per-test reset
 * helpers) can call _resetEventBridgeForTests to drop everything between
 * cases without round-tripping through reload.
 */
import type { EventBus, EventEnvelope, Unsubscribe } from '../events/bus';
import type { PluginSnapshot } from '../plugins/registry';
import { runSkill } from './runner';

interface Binding {
  topic: string;
  skillId: string;
  pluginId: string;
  unsubscribe: Unsubscribe;
}

let _bindings: Binding[] = [];

/** Tear down current event-trigger bindings. Idempotent. */
export function _resetEventBridgeForTests(): void {
  for (const b of _bindings) {
    try { b.unsubscribe(); } catch { /* swallow */ }
  }
  _bindings = [];
}

export interface EventBridgeStats {
  bindings: Array<{ topic: string; skillId: string; pluginId: string }>;
  generation: number;
}

/** (Re)wire event triggers from a snapshot. Returns the binding stats. */
export function syncEventTriggerBindings(
  snapshot: PluginSnapshot,
  bus: EventBus,
): EventBridgeStats {
  // Drop everything from the previous snapshot first — bindings are
  // immutable by design, so re-creating is cheaper than diffing.
  for (const b of _bindings) {
    try { b.unsubscribe(); } catch { /* swallow */ }
  }
  _bindings = [];

  for (const skill of snapshot.kinds.skills) {
    for (const trig of skill.definition.triggers) {
      if (trig.kind !== 'event') continue;
      const topic = trig.topic;
      const skillId = skill.definition.id;
      const pluginId = skill.pluginId;
      const unsub = bus.subscribe(topic, (env: EventEnvelope) => {
        // Fire-and-forget; the runner emits skill.* events that interested
        // observers can subscribe to. Errors caught and ignored — we don't
        // want a single bad skill to take down the bridge.
        void runSkill({
          skillId,
          input: { event: env },
          caller: { kind: 'event', threadId: env.threadId ?? undefined },
        }).catch(() => undefined);
      });
      _bindings.push({ topic, skillId, pluginId, unsubscribe: unsub });
    }
  }
  return {
    bindings: _bindings.map(({ topic, skillId, pluginId }) => ({ topic, skillId, pluginId })),
    generation: snapshot.generation,
  };
}

/** Read-only view of currently active bindings. */
export function listEventBridgeBindings(): EventBridgeStats {
  return {
    bindings: _bindings.map(({ topic, skillId, pluginId }) => ({ topic, skillId, pluginId })),
    generation: -1,
  };
}
