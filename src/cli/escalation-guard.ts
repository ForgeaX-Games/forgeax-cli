/**
 * 权限升级护栏(E-05)—— 进入「危险姿态」前的防自己检查。HOST 层。
 *
 * 两条危险入口:
 *   - `--yes`(makeAskUser(true))= 自动放行一切 ask,等效 CC 的 `--dangerously-skip-permissions`;
 *   - `/permissions bypassPermissions` = 切 bypass 模式(deny/safetyCheck 仍免疫,但 ask/allow 全放)。
 *
 * 护栏(对齐 CC:root 拒绝 + killswitch):
 *   1. **root/sudo 拒绝**——`process.getuid?.() === 0` 时拒绝 --yes 与 bypass(误伤面最大);
 *   2. **settings killswitch**——`disableBypassPermissionsMode: true`(顶层或 permissions 下)时拒绝切 bypass。
 *
 * 纯判定,不做 IO(除读已缓存的 settings);调用方据结果拒绝并给出 reason。
 * Boundary: 仅 core 相对 + node(process 全局)。
 */
import { getMergedSettings } from './settings';

/** 当前是否 root(仅 POSIX 有 getuid;其它平台视为非 root)。 */
export function isRoot(): boolean {
  const getuid = (process as { getuid?: () => number }).getuid;
  return typeof getuid === 'function' && getuid() === 0;
}

/** settings 是否禁用 bypass 模式(顶层 or permissions.* 任一为 true)。 */
export function bypassDisabledBySettings(cwd: string = process.cwd()): boolean {
  const s = getMergedSettings(cwd) as {
    disableBypassPermissionsMode?: unknown;
    permissions?: { disableBypassPermissionsMode?: unknown };
  };
  return s.disableBypassPermissionsMode === true || s.permissions?.disableBypassPermissionsMode === true;
}

export interface EscalationVerdict {
  allowed: boolean;
  reason?: string;
}

/** `--yes`(全量放权)是否放行:root 下拒绝。 */
export function guardYes(): EscalationVerdict {
  if (isRoot()) {
    return { allowed: false, reason: 'refusing --yes (auto-approve all) while running as root/sudo — too dangerous. Run as a non-root user.' };
  }
  return { allowed: true };
}

/** 切 `bypassPermissions` 是否放行:root 拒绝;settings killswitch 拒绝。 */
export function guardBypassMode(cwd: string = process.cwd()): EscalationVerdict {
  if (isRoot()) {
    return { allowed: false, reason: 'refusing bypassPermissions while running as root/sudo — too dangerous.' };
  }
  if (bypassDisabledBySettings(cwd)) {
    return { allowed: false, reason: 'bypassPermissions is disabled by settings (disableBypassPermissionsMode).' };
  }
  return { allowed: true };
}
