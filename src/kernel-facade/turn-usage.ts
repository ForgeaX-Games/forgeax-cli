import type { ProviderStreamEvent, Usage } from '../provider/types';

const fields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const;
/** Provider events are snapshots of one request, never additive deltas.
 * Final assistant usage supersedes snapshots. Only request boundaries add usage.
 * Incomplete accounting stays absent on the host wire, rather than becoming zero.
 */
export class TurnUsage {
  private current: Partial<Usage> | undefined;
  private started = false;
  private total: Partial<Usage> = {};
  private missing = new Set<keyof Usage>();

  begin(): void {
    this.finish();
    this.current = {};
    this.started = false;
  }
  observe(event: ProviderStreamEvent): void {
    if (event.type !== 'message_start' && event.type !== 'message_delta' && event.type !== 'assistant') return;
    // Some providers retry internally, without another agent provider_call stage.
    if (event.type === 'message_start') {
      if (this.started) this.begin();
      this.started = true;
    }
    this.current ??= {};
    const reported = event.usage.reported ?? event.usage;
    for (const field of fields) {
      const n = reported[field];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) this.current[field] = n;
    }
  }
  finish(): void {
    if (!this.current) return;
    for (const field of fields) {
      const n = this.current[field];
      if (n === undefined) this.missing.add(field);
      else this.total[field] = (this.total[field] ?? 0) + n;
    }
    this.current = undefined;
  }
  values() {
    this.finish();
    const get = (field: typeof fields[number]) => this.missing.has(field) ? undefined : this.total[field];
    return { inputTokens: get('inputTokens'), outputTokens: get('outputTokens'),
      cacheRead: get('cacheReadInputTokens'), cacheCreation: get('cacheCreationInputTokens') };
  }
}
