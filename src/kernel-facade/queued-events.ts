/** Wake the facade while its native generator is awaiting work (for example,
 * a compaction summary). There is only one outstanding source.next(). */
export class QueuedEvents<T> {
  private items: T[] = [];
  private wake?: () => void;

  push(item: T): void { this.items.push(item); this.wake?.(); }

  async *interleave<U>(input: AsyncIterable<U>): AsyncGenerator<{ queued: T } | { native: U }> {
    const source = input[Symbol.asyncIterator]();
    // Attach rejection handling before yielding queued work: consumers may pause
    // or dispose while a native next() rejects under backpressure.
    const next = () => source.next().then(
      result => ({ result }),
      error => ({ error }),
    );
    let pending = next();
    try {
      for (;;) {
        const notice = new Promise<null>(resolve => { this.wake = () => resolve(null); });
        while (this.items.length) yield { queued: this.items.shift()! };
        const result = await Promise.race([pending, notice]);
        this.wake = undefined;
        if (result === null) continue;
        // Synchronous bus publications precede the native event they accompany.
        while (this.items.length) yield { queued: this.items.shift()! };
        if ('error' in result) throw result.error;
        if (result.result.done) break;
        yield { native: result.result.value };
        pending = next();
      }
    } finally {
      this.wake = undefined;
      this.items = [];
      // The owner aborts source work through its signal. Never block disposal
      // on a provider that is still settling its outstanding next().
      void source.return?.().catch(() => {});
    }
  }
}
