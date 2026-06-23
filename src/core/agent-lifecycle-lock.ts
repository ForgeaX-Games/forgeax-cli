/** AgentLifecycleLock —— per-key async mutex，串行化单个 agent 的 init / restart /
 *  shutdown / reload 等操作；不同 key 互不阻塞。
 *
 *  与 agenteam ref 1:1。
 *
 *  ## 模式
 *
 *  - **默认**：late caller 排队等 in-flight 完成后顺序执行；fn 一定会跑。
 *  - **skipIfBusy**: late caller 见锁直接返回 undefined；适合「下一 tick 还能再来」
 *    的轮询场景（src/ 文件改动检测）。
 *
 *  ## 不变式 —— "set BEFORE await"
 *
 *  next promise 必须在 await prev 之前注册到 map，否则多个 late caller 会同时
 *  await prev，prev 一 resolve 就并发 fork 出多份 fn。 */

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
    // chain BEFORE awaiting prev — see header docstring。
    const next: Promise<T> = (prev ? prev.catch(() => undefined) : Promise.resolve())
      .then(() => fn());
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      // 只有当 map 中尾部仍是自己时才清理；否则后继者已经 chain 上去，map 值是
      // 后继的 next，留给它自己清。
      if (this.locks.get(id) === next) {
        this.locks.delete(id);
      }
    }
  }
}
