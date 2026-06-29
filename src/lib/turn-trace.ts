/** turn 诊断日志(DEBUG 级)—— 走项目**通用日志通道**,不再写独立文件。
 *
 *  实现:直接 `console.debug(...)`。`core/logger.ts` 的 `installConsoleBridge` 会按
 *  ALS `LogContext.sid` 把它路由进 `<sid>/logs/debug.log`(+ `latest.log`);无 sid
 *  时落 globalLogger(user-root debug.log)。即与全仓其它日志同一套口径,可统一检索/轮转。
 *
 *  开关:env `FORGEAX_TURN_TRACE`(缺省**关**,零成本、不给 session debug.log 添噪)。
 *  打开后 `tt(tag, fields)` 输出一行结构化 DEBUG;`ttEnabled()` 供调用方跳过昂贵拼装 /
 *  高频看门狗判断。排查 turn 卡死 / 封口 / ask_user 往返时临时开启,非排查期保持关闭。 */

let enabled: boolean | null = null;

function resolveEnabled(): boolean {
  if (enabled === null) {
    const v = process.env.FORGEAX_TURN_TRACE?.trim().toLowerCase();
    enabled = !!v && v !== '0' && v !== 'false' && v !== 'off';
  }
  return enabled;
}

/** 是否开启(供调用方跳过昂贵字段拼装 / 高频看门狗 setInterval 判断)。 */
export function ttEnabled(): boolean {
  return resolveEnabled();
}

/** 写一行 turn 诊断日志(tag + 任意字段),经通用 console 桥落 session 日志。
 *  enabled=false 时近乎零成本;永不抛(诊断日志绝不能打断 turn)。 */
export function tt(tag: string, fields: Record<string, unknown> = {}): void {
  if (!resolveEnabled()) return;
  try {
    console.debug(`[turn-trace] ${tag}`, fields);
  } catch {
    /* diagnostic logging must never break the turn */
  }
}
