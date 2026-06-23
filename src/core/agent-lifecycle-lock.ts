// @desc Per-id async lock serializing agent lifecycle mutations (init/restart/shutdown/remove).

/**
 * Per-key async mutex.
 *
 * Operations on the same key run strictly in arrival order; different keys
 * proceed independently. Used by Scheduler so all lifecycle mutations on the
 * same agent (init / restart / shutdown / remove / src-driven changes / crash
 * cleanup) serialize, eliminating duplicate-instance races.
 *
 * ## Acquisition modes
 *
 * - **Default** (no opts): late callers chain after any in-flight op and run
 *   when their turn arrives. Use for control API paths where the request must
 *   not be silently dropped. Returns `Promise<T>` — `fn` is guaranteed to run.
 *
 * - **skipIfBusy**: late callers return `undefined` immediately when the lock
 *   is held. Use for polling paths where retrying on the next tick is fine
 *   (e.g. ScriptAgent src/ change detection). Returns `Promise<T | undefined>`.
 *
 * ## Implementation invariant — "set BEFORE await"
 *
 * The chained `next` Promise is registered to the map BEFORE awaiting prev.
 * This guarantees that subsequent callers arriving while we are still queued
 * see `next` as the tail and chain on top of it.
 *
 * A naive "await prev; create p = fn(); locks.set(id, p)" pattern lets multiple
 * late callers all await the same `prev`. When `prev` resolves, every
 * continuation simultaneously creates its own `p` and writes to the map → fns
 * run in parallel, defeating the lock.
 *
 * The pattern below threads each new caller onto the current tail synchronously
 * (no await between `get(id)` and `set(id, next)`), so Node's single-threaded
 * event loop guarantees a strict chain.
 */
export class AgentLifecycleLock {
  private locks = new Map<string, Promise<unknown>>();

  acquire<T>(id: string, fn: () => Promise<T>): Promise<T>;
  acquire<T>(id: string, fn: () => Promise<T>, opts: { skipIfBusy: true }): Promise<T | undefined>;
  async acquire<T>(
    id: string,
    fn: () => Promise<T>,
    opts: { skipIfBusy?: boolean } = {},
  ): Promise<T | undefined> {
    if (opts.skipIfBusy && this.locks.has(id)) return undefined;
    const prev = this.locks.get(id);
    // Build chained promise BEFORE awaiting prev — see file-level docstring.
    // .catch swallows prior errors so one failed op doesn't break the chain.
    const next: Promise<T> = (prev ? prev.catch(() => undefined) : Promise.resolve())
      .then(() => fn());
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      // Only delete if this Promise is still the registered tail. A successor
      // may have already chained on top of us, in which case the map's value
      // is now the successor's `next`, not ours — leaving it alone is correct.
      if (this.locks.get(id) === next) {
        this.locks.delete(id);
      }
    }
  }
}
