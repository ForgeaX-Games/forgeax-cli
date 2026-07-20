/** /init —— 扫描项目生成 AGENTS.md(019)。driver.runInit(→ runInitProject 子流程)。
 *  /init --force 显式允许覆盖既有文档。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'init',
  desc: '扫描项目生成 AGENTS.md(/init [--force])',
  run: async (ctx, args) => {
    const force = /^--?force$/.test(args.trim());
    ctx.print('🔍 正在扫描项目并生成 AGENTS.md...');
    const r = await ctx.runInit(force);
    // 降级分支(离线 / 模型不可达 / 超时):不再假报成功,给可操作提示(F3)。
    if (!r.ok) {
      if (r.reason === 'timeout') {
        ctx.print('⏱️ /init 超时已取消:疑似离线或模型不可达。请检查网络 / 代理 / ANTHROPIC_API_KEY 后重试。');
      } else {
        ctx.print(`❌ /init 未能生成:${r.detail ?? '未知错误'}(疑似离线或模型不可达)。请检查网络 / API Key 后重试。`);
      }
      return;
    }
    const note = r.existing.exists && !force ? '(检测到既有文档,已增量补充)' : '';
    ctx.print(`✅ 已生成 ${r.fileName} -> ${r.targetPath}${note}`);
  },
});
