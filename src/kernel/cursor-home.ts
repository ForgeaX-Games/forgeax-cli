/**
 * cursor-home — 给 cursor headless turn 一个「镜像 HOME」,屏蔽用户**个人全局** MCP。
 *
 * 问题:cursor 把用户个人全局 MCP server 读自 `homedir()/.cursor/mcp.json`,headless
 * 每轮都会去连(远程 server initialize+tools/list 握手,实测 ~5s/轮),而这些 server
 * (用户自己 Cursor IDE 用的 github/tapd/监控等)与 Studio 游戏开发无关。cursor-agent
 * **没有** `--strict-mcp-config` 之类的隔离 flag,也没有 env
 * 能单独屏蔽全局配置——其路径就是 node `homedir()`(= `$HOME`),且 project 级空配置/
 * `disabled` 都覆盖不掉用户全局(实测合并、不被 override)。
 *
 * 解法:把真实 `$HOME` 的所有顶层项 **symlink** 进一个临时目录,唯独 `.cursor` 换成真实
 * 子目录、逐项 symlink 真实 `~/.cursor` 但**跳过 `mcp.json`** → cursor 看到的身份/登录/
 * 历史全在(登录态 = macOS keychain + `~/Library` 下的加密 token,经顶层 `Library`
 * symlink 续上;chats/projects/cli-config 等经各自 symlink 续上,写入直穿到真实文件),
 * 唯独看不到用户个人 MCP server。实测:仍 `Logged in`,且每轮省 ~5s。
 *
 * 安全:全是 symlink,清理(`rmSync` recursive)只删链接、绝不动 target;任何一步失败都
 * 返回 `undefined`,调用方退回真实 `$HOME`(优雅降级——绝不为提速而丢登录)。仅
 * darwin/linux(Windows 默认无 symlink 权限 + 配置路径不同 → 直接跳过,退回现状)。
 *
 * **默认关闭(opt-in)**:本加速会改变 cursor 看到的 HOME,虽实测保住登录,但耦合了
 * 「cursor auth 经 homedir/keychain 取」这一假设——未来 cursor 改 auth 存储有让登录失效
 * 的尾部风险。故默认**不启用、保持原有逻辑**(真实 `$HOME`),仅当显式设置
 * `FORGEAX_CURSOR_ISOLATE_MCP=1`(或 true/yes/on)时才镜像。万一启用后出问题,清掉该 env
 * 即刻退回原状,无需改代码/发版。
 */
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

/** opt-in 开关:仅当 `FORGEAX_CURSOR_ISOLATE_MCP` 显式为真值时才启用镜像 HOME。
 *  缺省(未设/其它值)→ false → 保持原有逻辑(真实 `$HOME`)。 */
function isolateEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.FORGEAX_CURSOR_ISOLATE_MCP?.trim() ?? '');
}

/** 文件名:不进镜像 `.cursor` 的项(即要对 cursor 隐藏的用户个人 MCP 配置)。 */
function isHiddenMcpConfig(name: string): boolean {
  return name === 'mcp.json' || name === '.mcp.json' || name.startsWith('mcp.json.bak');
}

/**
 * 构建一个镜像 HOME(屏蔽 `~/.cursor/mcp.json`)。成功返回新临时目录路径(调用方设为子进程
 * `HOME` 并在 turn 结束后 `disposeCursorHome` 清理);**默认/失败/不支持平台返回 `undefined`**
 * → 调用方退回真实 `$HOME`(原有逻辑)。仅当 `FORGEAX_CURSOR_ISOLATE_MCP=1` 时才真正镜像。
 */
export function buildCursorHomeWithoutUserMcp(): string | undefined {
  if (!isolateEnabled()) return undefined;
  if (process.platform === 'win32') return undefined;
  // iso 提到 try 外:mkdtemp 之后任何一步抛错(readdir/mkdir/...),catch 里要把已建的
  // 临时目录清掉,否则 opt-in + FS 故障下每轮会孤儿泄漏一个 forgeax-cursor-home-* 目录。
  let iso: string | undefined;
  try {
    const real = homedir();
    if (!real) return undefined;
    iso = mkdtempSync(join(tmpdir(), 'forgeax-cursor-home-'));

    // 顶层:真实 $HOME 的每一项都 symlink 过去(.cursor 除外,下面单独处理)。这样 cursor
    // 读 ~/Library(keychain/token)、~/.gitconfig、~/.ssh 等都续得上 → 登录与工具不受影响。
    for (const entry of readdirSync(real)) {
      if (entry === '.cursor') continue;
      try { symlinkSync(join(real, entry), join(iso, entry)); } catch { /* 单项失败不致命 */ }
    }

    // .cursor:真实子目录,逐项 symlink 真实 ~/.cursor,唯独跳过 mcp.json(写入经 symlink
    // 直穿真实文件,故 chats/projects/cli-config/statsig 等历史与状态都续得上)。
    const realCursor = join(real, '.cursor');
    if (existsSync(realCursor)) {
      const isoCursor = join(iso, '.cursor');
      mkdirSync(isoCursor);
      for (const entry of readdirSync(realCursor)) {
        if (isHiddenMcpConfig(entry)) continue;
        try { symlinkSync(join(realCursor, entry), join(isoCursor, entry)); } catch { /* 单项失败不致命 */ }
      }
    }
    return iso;
  } catch {
    disposeCursorHome(iso); // 清掉已建的孤儿临时目录(若 mkdtemp 已成功);只删 symlink 骨架。
    return undefined;
  }
}

/** 清理镜像 HOME。只删 symlink + 临时目录骨架,绝不触碰真实 target(symlink 的 rm 语义)。 */
export function disposeCursorHome(isoHome: string | undefined): void {
  if (!isoHome) return;
  try { rmSync(isoHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}
