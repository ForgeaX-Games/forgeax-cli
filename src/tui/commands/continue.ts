/** /continue —— 续接**最近活跃**会话(H-04,与 CLI `-c/--continue` 同语义 SSOT)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
import { mostRecentSessionId } from '../../cli/resume-fold';

registerCommand({
  name: 'continue',
  desc: '续接最近活跃会话',
  run: async (ctx) => {
    const id = mostRecentSessionId();
    if (!id) {
      ctx.print('ℹ️ 没有可续接的会话。');
      return;
    }
    const ok = await ctx.resume(id);
    ctx.print(ok ? `✅ 已续接最近会话「${id}」。` : `ℹ️ 会话「${id}」无历史可续接。`);
  },
});
