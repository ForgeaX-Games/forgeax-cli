/** /permissions —— 查看权限规则与模式,带参切模式(017)。
 *  driver.getPermissionRules / setPermissionMode。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
import { coercePermissionMode, formatRuleView, PERMISSION_MODES, type PermissionRuleView } from '../../permission/inspect';
import { guardBypassMode } from '../../cli/escalation-guard';

registerCommand({
  name: 'permissions',
  desc: '查看权限规则;/permissions <mode> 切模式',
  run: (ctx, args) => {
    const m = args.trim();
    if (m) {
      const want = coercePermissionMode(m);
      if (!want) {
        ctx.print(`无效模式 ${m}。可选:${PERMISSION_MODES.join(' / ')}`);
        return;
      }
      // E-05:切 bypassPermissions 前过护栏(root 拒绝 / settings killswitch)。
      if (want === 'bypassPermissions') {
        const v = guardBypassMode();
        if (!v.allowed) {
          ctx.print(`⚠ 拒绝切换到 bypassPermissions:${v.reason}`);
          return;
        }
      }
      ctx.setPermissionMode(want);
      ctx.print(`已切换权限模式 -> ${want}`);
      return;
    }
    const v = ctx.getPermissionRules();
    // E-02 #4:展示规则来源(settings.permissions.* / 交互式 always-allow 等),便于用户
    //   知道每条规则从哪来。
    const bucket = (label: string, arr: PermissionRuleView[]): string =>
      arr.length ? `${label}:\n  ${arr.map(formatRuleView).join('\n  ')}` : `${label}:(空)`;
    ctx.print(
      [
        `权限模式:${v.mode}`,
        `概览:allow ${v.counts.allow} / ask ${v.counts.ask} / deny ${v.counts.deny}`,
        bucket('allow', v.allow),
        bucket('ask', v.ask),
        bucket('deny', v.deny),
      ].join('\n'),
    );
  },
});
