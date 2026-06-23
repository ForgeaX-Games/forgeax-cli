/** Session-layer types — StoredEvent (ledger-on-disk shape) and re-exports.
 *
 *  StoredEvent 与 core Event 的差异：
 *  - emitterId 字段（EventBus.emit 时由 caller 提供，路由完写盘）
 *  - payload 可能为 undefined（旧 ledger 行的兼容兜底）
 *  - 不带 block / isBlocked 函数（落盘前已经被 EventBus 剥掉）
 *
 *  ref agenteam context-window/system-snapshot.ts::StoredEvent；为避免反向依赖
 *  context-window 模块，这里独立持有一份。 */

export interface StoredEvent {
  type: string;
  ts: number;
  source?: string;
  to?: string;
  emitterId?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  handoff?: string;
  [key: string]: unknown;
}
