import { createHash } from 'node:crypto';

/** Per-run read observations; hashes bound memory without retaining file bodies. */
/** `same_file_read_limit` 默认 K(对齐 agentic_os 配置默认 20)。 */
export const DEFAULT_SAME_FILE_READ_LIMIT = 20;

export class ReadTracker {
  /** path → 累计读次数。 */
  private readonly counts = new Map<string, number>();
  private readonly observations = new Map<string, { digest: string; count: number }>();

  /** Count identical successful reads of the same request. Changed output is progress. */
  observe(path: string, request: string, output: string): number {
    this.record(path);
    const key = JSON.stringify([path, request]);
    const digest = createHash('sha256').update(output).digest('hex');
    const previous = this.observations.get(key);
    const count = previous?.digest === digest ? previous.count + 1 : 1;
    this.observations.set(key, { digest, count });
    return count;
  }

  /** 记一次读,返回该 path 累加后的新次数(便于调用方就地取用)。
   *  重读时把 path 移到 Map 末尾(delete+set)→ 保持「最近读在后」的插入序,供
   *  `recentPaths()` 产出最近优先列表(D-01 压后重挂自取)。 */
  record(path: string): number {
    const n = (this.counts.get(path) ?? 0) + 1;
    this.counts.delete(path);
    this.counts.set(path, n);
    return n;
  }

  /** 当前累计读次数(未读过 → 0)。 */
  count(path: string): number {
    return this.counts.get(path) ?? 0;
  }

  /** 最近读过的文件路径,**最新在前**(D-01 压后重挂的数据源:loop 自取自己的 tracker)。 */
  recentPaths(): string[] {
    return [...this.counts.keys()].reverse();
  }

  /**
   * 是否已越线(累计次数 > limit)。limit 缺省 = DEFAULT_SAME_FILE_READ_LIMIT。
   * 用「>」语义:K=20 时,第 21 次读才算 over(允许恰好读满 K 次)。
   * limit ≤ 0 或非有限 → 永不越线(fail-open,等价关闭该限制)。
   */
  over(path: string, limit: number = DEFAULT_SAME_FILE_READ_LIMIT): boolean {
    if (!Number.isFinite(limit) || limit <= 0) return false;
    return this.count(path) > limit;
  }

  /** 清空(测试 / run 复用时重置)。 */
  reset(): void {
    this.counts.clear();
    this.observations.clear();
  }
}
