/**
 * SessionManager 进程单例的访问器 —— 与 `SessionManager` 类本体**分包**。
 *
 * 这里对类只做 `import type`(配合 .dependency-cruiser.cjs 的
 * `tsPreCompilationDeps: false` ⇒ 类型边不计入依赖图),因此 kernel 层
 * (`kernel/compose-turn-request.ts`)可经此读取单例,而**不会**经
 * `session-manager.ts` 把 `ConsciousAgent` 拉进来,从而断开运行时环:
 *
 *   conscious-agent → kernel-turn → compose-turn-request → session-manager
 *                                                          → conscious-agent
 *
 * 单例的写入(`new SessionManager`)仍留在 `session-manager.ts`(它持有类本体),
 * 经 `setSessionManager` 注册;`session-manager.ts` 亦 re-export `getSessionManager`
 * 给既有消费者,故其它调用点零改。
 */
import type { SessionManager } from './session-manager';

let _instance: SessionManager | null = null;

/** 由 `initSessionManager` 在构造单例后注册。 */
export function setSessionManager(sm: SessionManager): void {
  _instance = sm;
}

export function getSessionManager(): SessionManager {
  if (!_instance) throw new Error("SessionManager not initialized — call initSessionManager(pm) first");
  return _instance;
}

/** nullable 读取(不抛),给 test-only disposer 用。 */
export function peekSessionManager(): SessionManager | null {
  return _instance;
}

/** 清空单例引用(不 dispose);dispose 由调用方先做。 */
export function clearSessionManager(): void {
  _instance = null;
}
